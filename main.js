/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

var net = require('net');
var os = require('os');
var path = require('path');

var apertureConfig = require('aperture-config').config;
var assert = require('assert-plus');
var bunyan = require('bunyan');
var cueball = require('cueball');
var dashdash = require('dashdash');
var dtrace = require('dtrace-provider');
var jsprim = require('jsprim');
var kang = require('kang');
var keyapi = require('keyapi');
var mahi = require('mahi');
var once = require('once');
var restify = require('restify');
var storinfo = require('storinfo');
var vasync = require('vasync');

var app = require('./lib');
var metadata_placement = require('./lib/metadata_placement');

///--- Internal Functions

function getMuskieOptions() {
    var options = [
        {
            names: ['file', 'f'],
            type: 'string',
            help: 'Configuration file to use.',
            helpArg: 'FILE'
        },
        {
            names: ['port', 'p'],
            type: 'positiveInteger',
            help: 'Listen for requests on port.',
            helpArg: 'PORT'
        },
        {
            names: ['verbose', 'v'],
            type: 'arrayOfBool',
            help: 'Verbose output. Use multiple times for more verbose.'
        }
    ];

    return (options);
}


/**
 * Command line option parsing and checking.
 *
 * @returns {Object} A object representing the command line options.
 */
function parseOptions() {
    var opts;
    var parser = new dashdash.Parser({options: getMuskieOptions()});

    try {
        opts = parser.parse(process.argv);
        assert.object(opts, 'options');
    } catch (e) {
        usage(parser, e.message);
    }

    if (!opts.file) {
        usage(parser, '-f option is required');
    }

    return (opts);
}

function usage(parser, message)
{
    console.error('muskie: %s', message);
    console.error('usage: node main.js OPTIONS\n');
    console.error(parser.help());
    process.exit(2);
}


function createMonitoringServer(cfg) {
    /*
     * Set up the monitoring server. This exposes a cueball kang monitoring
     * listener and an artedi-based metric collector.
     *
     * The cueball monitoring listener serves information about the cueball
     * Pools and Sets for connections to mahi, sharks, other services, and also
     * the moray client connections.
     *
     * The artedi-based metric collector is used to track various muskie
     * metrics including operation latency, and request counts.
     */
    var kangOpts;
    var monitorServer;
    var port;
    kangOpts = cueball.poolMonitor.toKangOptions();
    port = cfg.port + 800;

    monitorServer = restify.createServer({ name: 'Monitor' });
    monitorServer.get('/metrics', app.getMetricsHandler(cfg.collector));
    monitorServer.get(new RegExp('.*'), kang.knRestifyHandler(kangOpts));

    monitorServer.listen(port, '0.0.0.0', function () {
        cfg.log.info('monitoring server started on port %d', port);
    });
}


function createCueballSharkAgent(sharkCfg) {
    var sharkCueball = {
        resolvers: sharkCfg.resolvers,

        spares: sharkCfg.spares,
        maximum: sharkCfg.maximum,
        /*
         * Note that this path doesn't actually have to be handled by the
         * authcache (any non-5xx response code is accepted, e.g. 404 is fine).
         */
        ping: sharkCfg.ping,
        pingInterval: sharkCfg.pingInterval,
        tcpKeepAliveInitialDelay: sharkCfg.maxIdleTime,

        log: sharkCfg.log,
        recovery: {
            default: {
                retries: sharkCfg.retry.retries,
                timeout: sharkCfg.connectTimeout,
                maxTimeout: sharkCfg.maxTimeout,
                delay: sharkCfg.delay
            },
            /*
             * Avoid SRV retries, since authcache doesn't currently register
             * any useable SRV records for HTTP (it only registers redis).
             */
            'dns_srv': {
                retries: 0,
                timeout: sharkCfg.connectTimeout,
                maxTimeout: sharkCfg.maxTimeout,
                delay: 0
            }
        }
    };

    return (new cueball.HttpAgent(sharkCueball));
}


function createAuthCacheClient(authCfg, agent) {
    assert.object(authCfg, 'authCfg');
    assert.string(authCfg.url, 'authCfg.url');
    assert.optionalObject(authCfg.typeTable, 'authCfg.typeTable');

    var options = jsprim.deepCopy(authCfg);
    var log = authCfg.log.child({component: 'mahi'}, true);
    options.log = log;

    options.typeTable = options.typeTable || apertureConfig.typeTable || {};
    options.agent = agent;

    return (mahi.createClient(options));
}


function createKeyAPIClient(opts, clients) {
    var log = opts.log.child({component: 'keyapi'}, true);
    var _opts = {
        log: log,
        ufds: opts.ufds
    };

    return (new keyapi(_opts));
}

function onMetadataPlacementClientConnect(clients, barrier, client) {
    clients.metadataPlacement = client;
    barrier.done('createMetadataPlacementClient');
}

function createMetadataPlacementClient(opts, onConnect) {
    assert.object(opts, 'options');
    assert.object(opts.buckets_mdplacement, 'options.buckets_mdplacement');
    assert.object(opts.buckets_mdapi, 'options.buckets_mdapi');
    assert.object(opts.log, 'options.log');

    var log = opts.log.child({component: 'metadataPlacementClient'}, true);

    var client = metadata_placement.createClient(opts);

    client.once('connect', function _onConnect() {
        log.info('metadataPlacementClient connected %s', client.toString());
        onConnect(client);
    });
}

function clientsConnected(appName, cfg, clients) {
    var server;
    var log = cfg.log;

    log.info('requisite client connections established, '
    + 'starting muskie servers');

    server = app.createServer(cfg, clients);
    server.on('error', function (err) {
        log.fatal(err, 'createServer() error');
        process.exit(1);
    });
    server.listen(cfg.port, function () {
        log.info('%s listening at port %s', appName, server.url);
    });

    app.startKangServer();
}

function createStorinfoClient(cfg, clients, barrier) {
    var opts = {
        log: cfg.log.child({component: 'storinfo'}, true),
        url: cfg.storinfo.url,
        pollInterval: cfg.storinfo.pollInterval,
        cueballOpts: cfg.storinfo.cueballOpts,
        defaultMaxStreamingSizeMB: cfg.storage.defaultMaxStreamingSizeMB,
        maxUtilizationPct: cfg.storage.maxUtilizationPct,
        multiDC: cfg.storage.multiDC,
        standalone: false
    };

    clients.storinfo = storinfo.createClient(opts);

    clients.storinfo.once('topology', function () {
        opts.log.info('first poll completed');
        barrier.done('createStorinfoClient');
    });
}

///--- Mainline

(function main() {
    const muskie = 'muskie';

    // Parent object for client connection objects.
    var clients = {};

    // DTrace probe setup
    var dtp = dtrace.createDTraceProvider(muskie);
    var client_close = dtp.addProbe('client_close', 'json');
    var socket_timeout = dtp.addProbe('socket_timeout', 'json');

    client_close.dtp = dtp;
    socket_timeout.dtp = dtp;
    dtp.enable();

    const dtProbes = {
        client_close: client_close,
        socket_timeout: socket_timeout
    };

    const opts = parseOptions();
    const cfg = app.configure(muskie, opts, dtProbes);

    /*
     * Create a barrier to ensure client connections that are established
     * asynchronously and are required for muskie to serve a minimal subset of
     * requests are ready prior to starting up the restify servers.
     */
    var barrier = vasync.barrier();

    barrier.on('drain', clientsConnected.bind(null, muskie, cfg, clients));

    /*
     * Establish minimal set of client connections required to begin
     * successfully servicing non-jobs read requests.
     */

    clients.agent = new cueball.HttpAgent(cfg.cueballHttpAgent);
    clients.mahi = createAuthCacheClient(cfg.auth, clients.agent);

    barrier.start('createStorinfoClient');
    createStorinfoClient(cfg, clients, barrier);

    var metadataPlacementOpts = {
        buckets_mdplacement: cfg.buckets_mdplacement,
        buckets_mdapi: cfg.buckets_mdapi,
        log: cfg.log
    };
    barrier.start('createMetadataPlacementClient');
    createMetadataPlacementClient(metadataPlacementOpts,
        onMetadataPlacementClientConnect.bind(null, clients, barrier));

    // Establish other client connections needed for writes and jobs requests.
    clients.sharkAgent = createCueballSharkAgent(cfg.sharkConfig);
    clients.keyapi = createKeyAPIClient(cfg);

    // Create monitoring server
    createMonitoringServer(cfg);

    process.on('SIGHUP', process.exit.bind(process, 0));

})();
