var exports = module.exports = {};
var _ = require('lodash');
var Log = require('log');
var cliArgs = require('optimist').argv;
var log = new Log((cliArgs.d || cliArgs.debug) ? 'debug' : 'info');
var config = require('../conf/intelligence_bank_config.json');

var AWS = require('aws-sdk');
AWS.config.loadFromPath('./conf/aws.json');
var docClient = new AWS.DynamoDB.DocumentClient();

var IntelligenceBank = require('./intelligence_bank_client.js');

// MPR, 10/14/16: I hate this dumb expensive transform so much. ![](http://i.imgur.com/vDvVOWh.gif)
var stripEmptyValuesDeep = function (obj) {
    return _.reduce(obj, function (a, v, k) {
        if (v !== '') {
            a[k] = v;
            if (_.isObject(v) && !_.isArray(v)) {
                a[k] = stripEmptyValuesDeep(v);
            }
        }
        return a;
    }, {});
};

const IB_API_URL = 'https://apius.intelligencebank.com';

var transformFolderToExpected = function (resourceLocationUrl, folderId, data) {
    var transformed = data;
    transformed.items = [];
    /* eslint-disable camelcase */
    transformed.asset_type = 'folder';
    transformed.media_id = transformed.folderuuid;
    /* eslint-enable camelcase */
    transformed.type = 'folder';
    if (transformed.sortorder != null) {
        transformed.order = transformed.sortorder;
    }
    if (transformed.createdtime != null) {
        transformed.created = data.createdtime;
    }
    transformed.items = transformed.items.concat(_.map(data.resource || [], function (item) {
        return transformResourceToExpected(resourceLocationUrl, item);
    }));
    transformed.items = transformed.items.concat(_.map(transformed.folder, function (item, orderKey) {
        var transform = transformFolderToExpected(resourceLocationUrl, item.folderuuid, item);
        transform.order = transform.order || 100 + orderKey;
        return transform;
    }));

    transformed.items = _.reduce(transformed.items, (a, v) => {
        a.push(v);
        return a;
    }, []);

    transformed = stripEmptyValuesDeep(transformed);

    delete transformed.createdtime;
    delete transformed.sortorder;
    delete transformed.resource;
    delete transformed.folder;
    delete transformed.folderuuid;
    delete transformed.folder;

    return transformed;
};

var transformResourceToExpected = function (resourceLocationUrl, data) {
    var ext = '';
    var transformed = data;
    if (transformed.file) {
        transformed = _.defaults(transformed, transformed.file);
    }
    transformed.type = 'file';
    /* eslint-disable camelcase */
    transformed.asset_type = 'item';
    /* eslint-enable camelcase */
    transformed.order = transformed.sortorder || 1;
    transformed.check = {
        value: transformed.filehash,
        type: 'md5'
    };
    /* eslint-disable camelcase */
    transformed.media_id = data.resourceuuid || data.uuid;
    /* eslint-enable camelcase */
    transformed.name = data.title;
    if (transformed.origfilename) {
        ext = transformed.origfilename.split('.').pop();
        transformed.ext = ext;
    }
    if (transformed.ext) {
        ext = transformed.ext;
    }
    transformed.src = resourceLocationUrl + transformed.media_id + '.' + ext;
    transformed.thumb = resourceLocationUrl + transformed.media_id + '.' + ext + '&compressiontype=2&size=25';

    data.tags = data.tags || [];

    transformed.mime_type = transformed.mime_type || transformed.mimetype;// eslint-disable-line camelcase

    data.tags.forEach(tag => {
        if (tag.indexOf('asset_type') === 0) {
            transformed.asset_type = tag.split('-')[1]; // eslint-disable-line camelcase
        } else if (~tag.indexOf(':')) {
            transformed[tag.split(':')[0].toLowerCase()] = tag.split(':')[1];
        } else {
            transformed[tag.toLowerCase()] = true; // eslint-disable-line camelcase
        }
    });

    //DynamoDB is apparently out of their damn mind and doesn't allow empty
    // strings in their database.
    // MAX - If you pay to see my nomad PHP talk Tomorrow,
    // I will go over why dynamo cannot have empty values - MC
    transformed = stripEmptyValuesDeep(transformed);

    delete transformed.file;
    delete transformed.data;
    delete transformed.filehash;
    delete transformed.resourceuuid;
    delete transformed.sortorder;
    delete transformed.versions;
    delete transformed.mimetype;

    return transformed;
};

var ibClient = new IntelligenceBank({
    baseUrl: IB_API_URL,
    username: config.username,
    password: config.password,
    platformUrl: config.platformUrl,
    ownUrl: config.host,
    //log: Log,
    transformFolder: transformFolderToExpected,
    transformAsset: transformResourceToExpected,
});


exports.init = function () {
    'use strict';

    docClient.get({
        TableName: 'intelligence_bank_keys',
        Key: {
            'key_name': 'apiKey'
        }
    }, function (err, data) {
        if (err || !Object.keys(data).length) {
            log.info('manually retrieving keys');
            ibClient.connect({
                username: config.username,
                password: config.password,
                platformUrl: config.platformUrl,
                ownUrl: config.host,
                onConnect: function (data_) {
                    log.info('success, caching data');
                    //store in dynamo
                    if (_.size(data.items)) {
                        docClient.put({TableName: 'intelligence_bank_keys', Item: {
                            'key_name': 'apiKey',
                            useruuid: data_.useruuid,
                            apiKey: data_.apiKey,
                            tracking: data_.tracking
                        }}, function (err_) {
                            if (err_ != null) {
                                log.warn('key cache store failed: ' + err_);
                            }
                        });
                    }
                }
            });
        } else {
            log.info('retrieving stored key');
            ibClient.connect({
                apiKey: data.Item.apiKey,
                useruuid: data.Item.useruuid,
                tracking: data.Item.tracking,
                platformUrl: config.platformUrl,
                ownUrl: config.host,
            });
        }
    });
};

/*
 * @param assetId (string) the id of the file or folder to find
 * @param r (function) the function the calls the resolve for the Promise
 */
exports.getAssetInfo = function (assetId, resolve, reject) {
    log.info('Getting general asset info for id ' + assetId + ' to determine folder or file type');
    var requestData = {};
    if (assetId !== '0' && (assetId.indexOf('/') !== -1 || assetId.length !== 32)) {
        if (assetId[assetId.length - 1] === '/') {
            assetId.slice(0, -1);
        }
        requestData.path = assetId;
    } else if (assetId != null && assetId !== 0 && assetId !== '0' && assetId !== '') {
        requestData.id = assetId;
    }
    //we do not know at this point if we have a folder or an asset. The only way to know
    //is to check both. One call will always fail, one will always succeed.

    var success = function (data_) {
        data_.id = data_.media_id || data_.uuid;
        resolve(data_);
    };

    ibClient.getAssetInfo(requestData)
        .then(success)
        .catch(function (assetError) {
            log.error('error when requesting asset information', assetError);
            ibClient.getFolderInfo(requestData)
                .then(success)
                .catch(function (folderError) {
                    log.error('error when requesting folder information', folderError);
                    reject(folderError);
                });
        });
};

/*
 * @param assetId (string) the id of the file or folder to find
 * @param r (function) the function the calls the resolve for the Promise
 */
exports.getAsset = function (assetId, r) {
    'use strict';
    log.debug('getting asset url for id ' + assetId);
    if (assetId[assetId.length - 1] === '/') {
        assetId.slice(0, -1);
    }
    ibClient.getAssetUrl(assetId).then(url => {
        r({url, tracking: ibClient.getTracking()});
    }).catch(err => {
        r({err, status: err.status || 500});
    });
};
