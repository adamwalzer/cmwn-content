var _ = require('lodash');
var Log = require('log');
var rollbar = require('rollbar');
var express = require('express');
var app = express();
var request = require('request');
var crypto = require('crypto');
var mime = require('mime-types');
var AWS = require('aws-sdk');
var timeout = require('connect-timeout');
var cliArgs = require('optimist').argv;
var log = new Log((cliArgs.d || cliArgs.debug) ? 'debug' : 'info');

var Util = require('./util.js');
var service = require('./intelligence_bank_service.js');
var IntelligenceBankConfig = require('../conf/intelligence_bank_config.json');
var rollbarKeys = require('../conf/rollbar.json');

AWS.config.loadFromPath('./conf/aws.json');
var docClient = new AWS.DynamoDB.DocumentClient();
var rollbarOpts = {
    environment: 'Media'
};

const CACHE_EXPIRY = 1; //hours

app.use(timeout(45000));
app.use(logOnTimedout);

app.use(function clientErrorHandler(err, req, res, next) {
    rollbar.reportMessageWithPayloadData('Error with request', {request: req, error: err});
    if (res.status) {
        res.status(500).send({ error: 'Something failed!' });
    } else {
        next();
    }
});

function logOnTimedout(req, res, next){
    if (req.timedout) {
        rollbar.reportMessageWithPayloadData('Got time out on request', req.url);
        res.status(429).send({ error: 'Something failed!' });
    }

    next();
}

function applyCurrentEnvironment(data) {
    var item = _.cloneDeep(data);
    if (item.src) {
        item.src = IntelligenceBankConfig.host + item.src;
    }
    if (item.thumb) {
        item.thumb = IntelligenceBankConfig.host + item.thumb;
    }
    if (item.items) {
        item.items = _.map(item.items, asset => applyCurrentEnvironment(asset));
    }
    return item;
}

// query the asset
app.get(/^\/a\/{0,1}(.+)?/i, function (req, res) {
    'use strict';
    var assetId;
    var assetResolve;
    var assetReject;
    var assetPromise;

    //unfortunately there is no non-breaking way around this global. Forgiveness.
    global.noCache = req.query.bust != null;

    var params = {
        TableName: 'media-cache',
        Key: {
            'path': IntelligenceBankConfig.host + req.url
        }
    };

    log.debug('request for url: ' + req.url);
    log.debug('using params: ' + req.params);

    assetId = req.params[0] || '0';
    log.debug('Asset Id or Path: ' + assetId);

    assetPromise = new Promise((resolve, reject) => {
        assetResolve = data => {
            resolve(data);
        };

        assetReject = data => {
            reject(data);
        };
    });

    assetPromise.then(data => {
        if (data) {
            res.send(applyCurrentEnvironment(data));
            log.debug(data);
            if (!data.cached) {
                log.info('Cache Miss');
                if (_.size(data.items)) {
                    docClient.put({TableName: 'media-cache', Item: {
                        path: IntelligenceBankConfig.host + req.url,
                        expires: Math.floor((new Date).getTime() / 1000) + CACHE_EXPIRY * 360000,
                        data: data
                    }}, function (err) {
                        if (err) {
                            log.error('cache store failed: ' + err);
                            rollbar.reportMessageWithPayloadData('Error trying to cache asset', {error: err, request: req});
                        }
                    });
                }
            } else {
                log.info('Cache Hit');
            }

        } else {
            log.debug('Asset not found');
            res.status(data && data.status || 404).send();
        }
    }).catch(err => {
        var status = err.status || 500;
        var message = err.message || 'Server Error [0x339]';
        log.info('asset with provided details could not be found');
        rollbar.reportMessageWithPayloadData('Error when trying to serve asset', {error: err, request: req});
        res.status(status).send({ message, status });
    });

    docClient.get(params, function (err, data) {
        if (err || !Object.keys(data).length || cliArgs.n || cliArgs.nocache, req.query.bust != null) {
            log.debug('No cache data for', data);
            service.getAssetInfo(assetId, assetResolve, assetReject);
        } else {
            if (!data || !data.Item || data.Item.expires - Math.floor((new Date).getTime() / 1000) < 0 ) {
                log.debug('Cache expired for', data);
                service.getAssetInfo(assetId, assetResolve, assetReject);
            } else {
                log.debug('Cache Hit', data);
                data.Item.data.cached = true;
                assetResolve(data.Item.data);
            }
        }
    });

});

// Serve the asset
app.get('/f/*', function (req, res) {
    'use strict';

    log.debug(req.url);
    log.debug(req.params);
    var isFallbackAttempt = false;

    var s3StoreFound = false;
    var key = '';

    var s3Bucket = 'cmwn-media-store';

    var s3 = new AWS.S3({
        apiVersion: '2006-03-01',
        params: {Bucket: s3Bucket}
    });

    var assetId = req.params[0] || '0';
    log.debug('Asset Id: ' + assetId);

    var query = '';
    if (~Util.transformS3ParamEncodedToQueried(req.url).indexOf('?')) {
        query = '?' + Util.transformS3ParamEncodedToQueried(req.url).split('?')[1];
    }

    var r;
    var rej;
    var p = new Promise((resolve, reject) => {
        r = resolve;
        rej = reject;
    });

    var retrieveAsset = function (data, err, err2) {
        var url;
        log.debug(data);
        log.debug(err);
        log.debug(err2);
        if (data.err) {
            res.status(data.status || 500).send({error: data.err});
        }
        if (data && data.url) {
            url = data.url;
            url = url.split('').pop() !== '&' ? url : url.slice(0, -1);
            res.contentType('image/png');
            log.info('making request ' + url + ' with cookie ' + data.tracking);
            request
                .get({
                    url,
                    encoding: null,
                    headers: { Cookie: data.tracking || '' }
                }, function (e, response, body) {
                    var extension;
                    var mimeType;
                    if (!e && response.statusCode === 200 && (body.length > 50 || !~body.indexOf('estimatedFileSize'))) {
                        try {
                            if (response.statusCode !== 200) {
                                res.status(500).send({error: 'File could not be returned'});
                                return;
                            }
                            res.set('cache-control', 'public, max-age=604800');
                            if (response.headers['content-disposition']) {
                                console.log('hork ' + JSON.stringify(response));
                                extension = response.headers['content-disposition'].split('.')[1].toLowerCase().replace('"', '');
                                mimeType = mime.lookup(extension);
                            }
                            if (!mimeType) {
                                mimeType = 'image/svg+xml';
                            }
                            console.log('dork');
                            res.set('content-type', mimeType);
                            res.contentType(mimeType);
                            res.set('etag', crypto.createHash('md5').update(data.url).digest('hex'));
                        } catch(error) {
                            log.error('Some content headers could not be set. Attempting to return asset. Reason: ' + error);
                        }

                        //don't waste the user's time storing before the asset has been returned
                        setTimeout(function () {
                            //store file result in s3
                            s3.upload({
                                Key: Util.transformQueriedToS3ParamEncoded(req.get('host') + '/' + req.path.slice(3), req.query), //slice off the /f/ at the front of all requests
                                Body: body,
                                ACL: 'public-read'
                            }, function (err_) {
                                if (err_) {
                                    log.error('There was an error uploading your photo: ' + err_.message);
                                }
                                log.info('Successfully uploaded photo.');
                            });
                        }, 500);


                        res.set('content-type', 'image/svg+xml');
                        //res.set('content-disposition', 'inline;');
                        res.send(body);
                    } else {
                        //note that this method of falling back will mask the original reason for failure
                        //so lets display it here
                        if (e && !isFallbackAttempt) {
                            log.debug('service failed for reason: ' + e);
                        } else {
                            log.debug('retrieval failure with status: ' + response.statusCode + ' and body ' + body);
                        }
                        if (s3StoreFound && !isFallbackAttempt) {
                            isFallbackAttempt = true;
                            log.info('Could not retrieve from service. Falling back to s3 store, at ' + 'https://s3.amazonaws.com/' + s3Bucket + '/' + key);
                            //attempt to ignore errors if we have a cached copy
                            retrieveAsset({url: 'https://s3.amazonaws.com/' + s3Bucket + '/' + key });
                        } else if (e) {
                            log.error('Server error [0xf07]: ' + e);
                            res.contentType('application/json');
                            res.status(500).send({error: 'Server error [0xf07]'});
                        } else {
                            res.contentType('application/json');
                            res.status(404).send({error: 'File not Found'});
                        }
                    }
                });
        } else {
            res.status(data && data.status || 404).send();
        }

        //we only set this global in the /f so that downstream changes don't try to use it
        //and get a stale value. Don't use this global if it can be avoided!
        global.noCache = req.query.bust != null;
    };

    //initially, check if we have a valid stored file to send back
    s3.listObjects({Prefix: req.get('host')}, function (err_, data_) { //remove /f/
        var now = new Date(Date.now());
        var expires = now;
        var searchKey = req.get('host') + '/' + Util.transformQueriedToS3ParamEncoded(req.path.slice(3), req.query);
        now.setHours(now.getHours());
        data_.Contents.map(function (photo) {
            if (photo.Key === searchKey) {
                s3StoreFound = true;
                key = photo.Key;
                expires = new Date(Date.parse(photo.LastModified));
                expires.setHours(expires.getHours() + CACHE_EXPIRY);
            }
        });
        //until we have the update service, these need to expire after a day
        //however, we dont want to delete them and make them unavailable, so
        //we want to fall back to the s3 version even if it is expired
        log.info('asset found in s3?: ' + s3StoreFound);
        if (s3StoreFound && req.query.bust == null && cliArgs.n == null && cliArgs.nocache == null && now < expires) {
            r({url: 'https://s3.amazonaws.com/' + s3Bucket + '/' + key });
        } else {
            log.info('skipping s3');
            service.getAsset(Util.transformS3ParamEncodedToQueried(assetId + query), r, function () {
                if (s3StoreFound) {
                    log.info('image unavailable from service, falling back to s3 store copy');
                    r({url: 'https://s3.amazonaws.com/' + s3Bucket + '/' + key });
                } else {
                    rej.apply(this, arguments);
                }
            });
        }
    });

    //after file has been retrieved
    p.then(retrieveAsset).catch(err => {
        rollbar.reportMessageWithPayloadData('Error when trying to serve asset', {error: err, request: req});
        res.status(500).send({ error: 'Something failed!' });
    });

});

// ping the service (used for health checks
app.get('/p', function (req, res) {
    'use strict';

    res.status(200).send('LGTM');
});

rollbar.init(rollbarKeys.token, rollbarOpts);
rollbar.handleUncaughtExceptions(rollbarKeys.token, rollbarOpts);
rollbar.handleUnhandledRejections(rollbarKeys.token, rollbarOpts);
app.use(rollbar.errorHandler(rollbarKeys.token, rollbarOpts));

app.listen(3000, function () {
    //service.init(storage);
    service.init();
    log.debug('App listening on port 3000!');
});
