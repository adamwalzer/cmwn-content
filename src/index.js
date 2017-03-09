var _ = require('lodash');
var Log = require('log');
var rollbar = require('rollbar');
var express = require('express');
var request = require('request-promise');
var app = express();
var crypto = require('crypto');
var AWS = require('aws-sdk');
var timeout = require('connect-timeout');
var cliArgs = require('optimist').argv;
var log = new Log((cliArgs.d || cliArgs.debug) ? 'debug' : 'info');

var service = require('./contentful_service.js');
var config = require('../conf/config.json');

AWS.config.loadFromPath('./conf/config.json');
//note that region, accessKeyId, and secretAccessKey must have these names
//and are AWS keys
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

// Serve the content
app.get('/c/*', function (req, res) {
    'use strict';

    log.debug(req.url);
    log.debug(req.params);

    var s3StoreFound = false;
    var key = '';

    var s3Bucket = 'cmwn-content-store';

    var s3 = new AWS.S3({
        apiVersion: '2006-03-01',
        params: {Bucket: s3Bucket}
    });

    var contentId = req.params[0] || '0';
    log.debug('Asset Id: ' + contentId);

    var r;
    var rej;
    var p = new Promise((resolve, reject) => {
        r = resolve;
        rej = reject;
    });

    var retrieveAsset = function (data, err, err2) {
        log.debug(data);
        log.debug(err);
        log.debug(err2);
        if (err) {
            res.status(data.status || 500).send({error: data.err});
        }
        try {
            if (_.isString(data)) {
                data = JSON.parse(data);
            }
            res.set('cache-control', 'public, max-age=604800');
            res.set('etag', crypto.createHash('md5').update(data.sys.id).digest('hex'));
        } catch(error) {
            log.error('Some content headers could not be set. Attempting to return asset. Reason: ' + error);
        }

        if (!s3StoreFound) {
            //don't waste the user's time storing before the asset has been returned
            setTimeout(function () {
                //store file result in s3
                s3.upload({
                    Key: req.get('host') + '/' + contentId + '.json',
                    Body: JSON.stringify(data),
                    ACL: 'public-read'
                }, function (err_) {
                    if (err_) {
                        log.error('There was an error uploading your photo: ' + err_.message);
                    }
                    log.info('Successfully uploaded content.');
                });
            }, 500);
        }

        res.send(data);
    };


    //initially, check if we have a valid stored file to send back
    s3.listObjects({Prefix: req.get('host')}, function (err_, data_) { //remove /f/
        var now = new Date(Date.now());
        var expires = now;
        var searchKey = req.get('host') + '/' + contentId + '.json';
        now.setHours(now.getHours());
        data_.Contents.map(function (content) {
            if (content.Key === searchKey) {
                s3StoreFound = true;
                key = content.Key;
                expires = new Date(Date.parse(content.LastModified));
                expires.setHours(expires.getHours() + CACHE_EXPIRY);
            }
        });
        //until we have the update service, these need to expire after a day
        //however, we dont want to delete them and make them unavailable, so
        //we want to fall back to the s3 version even if it is expired
        // MPR 3/9/16: disabling expiration for the time being, no need for it (readd with `&& now < expires` below)
        log.info('content found in s3?: ' + s3StoreFound);
        if (s3StoreFound && req.query.bust == null && cliArgs.n == null && cliArgs.nocache == null) {
            request.get('https://s3.amazonaws.com/' + s3Bucket + '/' + key).then(r).catch(s3Err => {
                service.getAssetById(contentId, r, function (serviceErr) {
                    log.error('failed to retrieve content from any source. s3 failure: ' + s3Err + ', contentful failure: ' + serviceErr);
                    rej.apply(this, arguments);
                });
            });
        } else {
            log.info('skipping s3');
            service.getAssetById(contentId, r, function () {
                if (s3StoreFound) {
                    log.info('image unavailable from service, falling back to s3 store copy');
                    request.get('https://s3.amazonaws.com/' + s3Bucket + '/' + key).then(r).catch(err => {
                        log.error('could not retrieve content from s3: ' + err);
                    });
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

rollbar.init(config.rollbar_token, rollbarOpts);
rollbar.handleUncaughtExceptions(config.rollbar_token, rollbarOpts);
rollbar.handleUnhandledRejections(config.rollbar_token, rollbarOpts);
app.use(rollbar.errorHandler(config.rollbar_token, rollbarOpts));

app.listen(3000, function () {
    //service.init(storage);
    service.init(config);
    log.debug('App listening on port 3000!');
});
