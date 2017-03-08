var exports = module.exports = {};
var Log = require('log');
var cliArgs = require('optimist').argv;
var log = new Log((cliArgs.d || cliArgs.debug) ? 'debug' : 'info');
var config = require('../conf/contentful_config.json');
var contentful = require('contentful');

var client = contentful.createClient({
    // This is the space ID. A space is like a project folder in Contentful terms
    space: config.spaceId,
    // This is the access token for this space. Normally you get both ID and the token in the Contentful web app
    accessToken: config.contentToken
});

exports.init = function () {
    'use strict';
};

/*
 * @param contentId (string) the id of the file or folder to find
 * @param r (function) the function the calls the resolve for the Promise
 */
exports.getAssetById = function (contentId, resolve, reject) {
    log.info('Getting content info for id ' + contentId);

    var success = function (data) {
        data.id = data.media_id || data.uuid;
        resolve(data);
    };

    client.getEntry(contentId)
        .then(success)
        .catch(function (assetError) {
            log.error('error when requesting content information', assetError);
            reject(assetError);
        });
};

