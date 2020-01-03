/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

var uuidv4 = require('uuid/v4');
var jsc = require('jsverify');

var shark_client = require('../lib/shark_client.js');

///--- Tests

/**
 * storagePathTest is a property test for the storagePath helper function in the
 * shark_client module. jsverify generates 100 random strings, and checks that
 * the property defined always holds. The property this tests is that the
 * storagePath function properly forms a object storage path by breaking long
 * object names into a series of subdirectories.
 */
exports.storagePathTest = function (t) {
    function propStoragePath(objectNameLen) {
        var objectName = 'a'.repeat(objectNameLen);
        var expectedPathPartCount =
            Math.floor(objectNameLen / shark_client.OBJECT_NAME_PART_SIZE) + 3;
        if (objectNameLen % shark_client.OBJECT_NAME_PART_SIZE > 0) {
            expectedPathPartCount += 1;
        }

        var storagePathOpts = {
            owner: uuidv4(),
            bucketId: uuidv4(),
            objectName: objectName,
            objectId: uuidv4()
        };

        var storagePath = shark_client.storagePath(storagePathOpts);

        var actualPathParts = storagePath.substr(1).split('/');
        var actualPathPartCount = actualPathParts.length;

        return (actualPathPartCount === expectedPathPartCount &&
                actualPathParts[0] === storagePathOpts.owner &&
                actualPathParts[1] === storagePathOpts.bucketId &&
                actualPathParts[expectedPathPartCount-1] ===
                    storagePathOpts.objectId);
    }

    var propRes =
        jsc.checkForall(jsc.integer(1, 1024), propStoragePath);

    // use equals, as propRes is a report object on property failure,
    // but it's contents are logged by jsverify
    t.ok(propRes === true, 'Property:: storagePath parts match');
    t.done();
};
