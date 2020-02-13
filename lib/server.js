/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var url = require('url');
var verror = require('verror');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var mime = require('mime');
var restify = require('restify');

var audit = require('./audit');
var auth = require('./auth');
var buckets = require('./buckets');
var common = require('./common');
var other = require('./other');
var throttle = require('./throttle');

var muskieUtils = require('./utils');

// injects into the global namespace
require('./errors');

///--- Globals

/* BEGIN JSSTYLED */
/*
 * from https://www.w3.org/Protocols/rfc1341/4_Content-Type.html
 * match 'type/subtype' where subtypes can be +/- delimited
 */
var VALID_CONTENT_TYPE_RE = /.+\/.+/;
/* END JSSTYLED */

///--- Helpers

// Always force JSON
function formatJSON(req, res, body) {
    if (body instanceof Error) {
        body = translateError(body, req);
        res.statusCode = body.statusCode || 500;
        if (res.statusCode >= 500)
            req.log.warn(body, 'request failed: internal error');

        if (body.headers !== undefined) {
            for (var h in body.headers) {
                res.setHeader(h, body.headers[h]);
            }
        }

        if (body.body) {
            body = body.body;
        } else {
            body = {
                message: body.message
            };
        }

    } else if (Buffer.isBuffer(body)) {
        body = body.toString('base64');
    }

    var data = JSON.stringify(body);
    var md5 = crypto.createHash('md5').update(data).digest('base64');

    res.setHeader('Content-Length', Buffer.byteLength(data));
    res.setHeader('Content-MD5', md5);
    res.setHeader('Content-Type', 'application/json');

    return (data);
}

///--- API

/**
 * Wrapper over restify's createServer to make testing and
 * configuration handling easier.
 *
 * @param {object} options            - options object.
 * @param {object} options.log        - bunyan logger.
 * @param {object} options.collector  - artedi metric collector.
 * @param {object} clients            - client connection object.
 * @throws {TypeError} on bad input.
 */
function createServer(options, clients) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.object(options.collector, 'options.collector');
    assert.object(options.throttle, 'options.throttle');
    assert.object(clients, 'clients');

    options.formatters = {
        'application/json': formatJSON,
        'text/plain': formatJSON,
        'application/octet-stream': formatJSON,
        'application/x-json-stream': formatJSON,
        '*/*': formatJSON
    };
    options.noWriteContinue = true;
    options.handleUpgrades = true;

    var log = options.log.child({
        component: 'HttpServer'
    }, true);
    var server = restify.createServer(options);

    /* Initialize metric collectors for use in handlers and audit logger. */
    // A counter to track the number of HTTP requests serviced.
    options.collector.counter({
        name: common.METRIC_REQUEST_COUNTER,
        help: 'count of Muskie requests completed'
    });
    // A histogram to track the time to first byte.
    options.collector.histogram({
        name: common.METRIC_LATENCY_HISTOGRAM,
        help: 'time-to-first-byte of Muskie requests'
    });
    // A histogram to track the time it took to fully process each HTTP request.
    options.collector.histogram({
        name: common.METRIC_DURATION_HISTOGRAM,
        help: 'total time to process Muskie requests'
    });
    // A pair of counters to track inbound and outbound throughput.
    options.collector.counter({
        name: common.METRIC_INBOUND_DATA_COUNTER,
        help: 'count of object bytes streamed from client to storage'
    });
    options.collector.counter({
        name: common.METRIC_OUTBOUND_DATA_COUNTER,
        help: 'count of object bytes streamed from storage to client'
    });
    options.collector.counter({
        name: common.METRIC_DELETED_DATA_COUNTER,
        help: 'count of deleted object bytes'
    });

    var _timeout = parseInt((process.env.SOCKET_TIMEOUT || 120), 10) * 1000;
    server.server.setTimeout(_timeout, function onTimeout(socket) {
        var l = (((socket._httpMessage || {}).req || {}).log || log);
        var req = socket.parser && socket.parser.incoming;
        var res = socket._httpMessage;

        if (req && req.complete && res) {
            l.warn('socket timeout: destroying connection');
            options.dtrace_probes.socket_timeout.fire(function onFire() {
                var dobj = req ? {
                    method: req.method,
                    url: req.url,
                    headers: req.headers,
                    id: req._id
                } : {};
                return ([dobj]);
            });
            socket.destroy();
        }
    });

    server.pre(function watchClose(req, res, next) {
        /*
         * In some cases, we proactively check for closed client connections.
         * Add a listener early on that just records this fact.
         */
        req.on('close', function () {
            req.log.warn('client closed connection');
            req._muskie_client_closed = true;
        });

        next();
    });
    server.pre(function stashPath(req, res, next) {
        req._probes = options.dtrace_probes;
        req.config = options;
        req.pathPreSanitize = url.parse(req.url).pathname;
        next();
    });
    /*
     * MANTA-331: while a trailing '/' is ok in HTTP, this messes with
     * the consistent hashing, so ensure there isn't one by using
     * sanitizePath()
     */
    server.pre(restify.pre.sanitizePath());
    server.pre(function cleanupContentType(req, res, next) {
        var ct = req.headers['content-type'];
        /*
         * content-type must have a type, '/' and sub-type
         */
        if (ct && !VALID_CONTENT_TYPE_RE.test(ct)) {
            req.log.debug('receieved a malformed content-type: %s', ct);
            req.headers['content-type'] = mime.lookup(ct);
        }

        next();
    });

    // set up random stuff
    other.mount(server);

    server.use(common.earlySetupHandler(options));
    server.use(restify.plugins.dateParser(options.maxRequestAge || 300));
    server.use(restify.plugins.queryParser());
    server.use(common.authorizationParser);
    server.use(auth.checkIfPresigned);

    server.use(function ensureDependencies(req, res, next) {
        var ok = true;
        var errors = [];
        var error;

        if (!clients.mahi) {
            error = 'mahi unavailable';
            errors.push(new Error(error));
            req.log.error(error);
            ok = false;
        }

        if (!clients.storinfo && !req.isReadOnly()) {
            error = 'storinfo unavailable';
            errors.push(new Error(error));
            req.log.error(error);
            ok = false;
        }

        if (!clients.metadataPlacement) {
            error = 'metadataPlacement client unavailable';
            errors.push(new Error(error));
            req.log.error(error);
            ok = false;
        }

        if (!ok) {
            next(new ServiceUnavailableError(req,
                        new verror.MultiError(errors)));
        } else {
            next();
        }
    });

    if (options.throttle.enabled) {
        options.throttle.log = options.log;
        var throttleHandle = throttle.createThrottle(options.throttle);
        server.use(throttle.throttleHandler(throttleHandle));
    }
    server.use(auth.authenticationHandler({
        log: log,
        mahi: clients.mahi,
        keyapi: clients.keyapi
    }));

    server.use(auth.gatherContext);

    // Add various fields to the 'req' object before the handlers get called.
    server.use(common.setupHandler(options, clients));

    // Buckets API
    addBucketsRoutes(server);

    // Tokens

    server.post({
        path: '/:account/tokens',
        name: 'CreateToken'
    }, auth.postAuthTokenHandler());


    var _audit = audit.auditLogger({
        collector: options.collector,
        log: log
    });

    server.on('after', function (req, res, route, err) {
        _audit(req, res, route, err);

        if ((req.method === 'PUT' || req.method === 'POST') &&
            res.statusCode >= 400) {
            /*
             * An error occurred on a PUT or POST request, but there may still
             * be incoming data on the request stream. Call resume() in order to
             * dump any remaining request data so the stream emits an 'end' and
             * the socket resources are not leaked.
             */
            req.resume();
        }
    });

    return (server);
}


function methodNotAllowHandler(req, res, next) {
    req.log.debug('Method ' + req.method + ' disallowed for ' + req.url);
    res.send(405);
    next(false);
}

/*
 * This function adds the following routes:
 *  - listing buckets
 *  - creating a bucket
 *  - getting a bucket
 *  - deleting a bucket
 *  - listing objects in a bucket
 *  - creating an object inside a bucket
 *  - getting an object from a bucket
 *  - deleting an object from a bucket
 */
function addBucketsRoutes(server) {

    server.get({
        path: '/:account/buckets',
        name: 'ListBuckets'
    }, buckets.listBucketsHandler());

    server.opts({
        path: '/:account/buckets',
        name: 'OptionsBuckets'
    }, buckets.optionsBucketsHandler());

    server.put({
        path: '/:account/buckets/:bucket_name',
        name: 'CreateBucket',
        contentType: '*/*'
    }, buckets.createBucketHandler());

    server.head({
        path: '/:account/buckets/:bucket_name',
        name: 'HeadBucket'
    }, buckets.headBucketHandler());

    server.del({
        path: '/:account/buckets/:bucket_name',
        name: 'DeleteBucket'
    }, buckets.deleteBucketHandler());

    server.get({
        path: '/:account/buckets/:bucket_name/objects',
        name: 'ListBucketObjects'
    }, buckets.listBucketObjectsHandler());

    server.put({
        path: '/:account/buckets/:bucket_name/objects/:object_name',
        name: 'CreateBucketObject',
        contentType: '*/*'
    }, buckets.createBucketObjectHandler());

    server.get({
        path: '/:account/buckets/:bucket_name/objects/:object_name',
        name: 'GetBucketObject'
    }, buckets.getBucketObjectHandler());

    server.head({
        path: '/:account/buckets/:bucket_name/objects/:object_name',
        name: 'HeadBucketObject'
    }, buckets.headBucketObjectHandler());

    server.del({
        path: '/:account/buckets/:bucket_name/objects/:object_name',
        name: 'DeleteBucketObject'
    }, buckets.deleteBucketObjectHandler());

    server.put({
        path: '/:account/buckets/:bucket_name/objects/:object_name/metadata',
        name: 'UpdateBucketObjectMetadata',
        contentType: '*/*'
    }, buckets.updateBucketObjectMetadataHandler());

    server.post({
        path: '/:account/buckets',
        name: 'PostBuckets'
    }, methodNotAllowHandler);

    server.put({
        path: '/:account/buckets',
        name: 'PutBuckets'
    }, methodNotAllowHandler);

    server.head({
        path: '/:account/buckets',
        name: 'PutBuckets'
    }, methodNotAllowHandler);

    server.del({
        path: '/:account/buckets',
        name: 'DeleteBuckets'
    }, methodNotAllowHandler);

    server.post({
        path: '/:account/buckets/:bucket_name/objects',
        name: 'PostBucketObjects'
    }, methodNotAllowHandler);

    server.put({
        path: '/:account/buckets/:bucket_name/objects',
        name: 'PutBucketObjects'
    }, methodNotAllowHandler);

    server.head({
        path: '/:account/buckets/:bucket_name/objects',
        name: 'HeadBucketObjects'
    }, methodNotAllowHandler);

    server.del({
        path: '/:account/buckets/:bucket_name/objects',
        name: 'DeleteBucketObjects'
    }, methodNotAllowHandler);

    server.head({
        path: '/:account/buckets/:bucket_name/objects/:object_name/metadata',
        name: 'HeadBucketObjectMetadata'
    }, methodNotAllowHandler);

    server.post({
        path: '/:account/buckets/:bucket_name/objects/:object_name/metadata',
        name: 'PostBucketObjectMetadata'
    }, methodNotAllowHandler);

    server.del({
        path: '/:account/buckets/:bucket_name/objects/:object_name/metadata',
        name: 'DeleteBucketObjectMetadata'
    }, methodNotAllowHandler);

}

///--- Exports

module.exports = {

    createServer: createServer,

    startKangServer: other.startKangServer,

    getMetricsHandler: other.getMetricsHandler
};
