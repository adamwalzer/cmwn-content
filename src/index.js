var Log = require('log');
var rollbar = require('rollbar');
var express = require('express');
var app = express();
var crypto = require('crypto');
var AWS = require('aws-sdk');
var timeout = require('connect-timeout');
var cliArgs = require('optimist').argv;
var log = new Log((cliArgs.d || cliArgs.debug) ? 'debug' : 'info');

var Util = require('./util.js');
var service = require('./contentful_service.js');
var rollbarKeys = require('../conf/rollbar.json');

AWS.config.loadFromPath('./conf/aws.json');
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

    var assetId = req.params[0] || '0';
    log.debug('Asset Id: ' + assetId);

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
            res.set('cache-control', 'public, max-age=604800');
            res.set('etag', crypto.createHash('md5').update(data).digest('hex'));
        } catch(error) {
            log.error('Some content headers could not be set. Attempting to return asset. Reason: ' + error);
        }

        res.send(data);

        if (!s3StoreFound) {
            //don't waste the user's time storing before the asset has been returned
            setTimeout(function () {
                //store file result in s3
                s3.upload({
                    Key: req.get('host') + '/' + assetId + '.json',
                    Body: data,
                    ACL: 'public-read'
                }, function (err_) {
                    if (err_) {
                        log.error('There was an error uploading your photo: ' + err_.message);
                    }
                    log.info('Successfully uploaded content.');
                });
            }, 500);
        }
    };


    //initially, check if we have a valid stored file to send back
    s3.listObjects({Prefix: req.get('host')}, function (err_, data_) { //remove /f/
        var now = new Date(Date.now());
        var expires = now;
        var searchKey = req.get('host') + '/' + Util.transformQueriedToS3ParamEncoded(req.path.slice(3), req.query);
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
        log.info('content found in s3?: ' + s3StoreFound);
        if (s3StoreFound && req.query.bust == null && cliArgs.n == null && cliArgs.nocache == null && now < expires) {
            r({url: 'https://s3.amazonaws.com/' + s3Bucket + '/' + key });
        } else {
            log.info('skipping s3');
            service.getAssetById(assetId, r, function () {
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
