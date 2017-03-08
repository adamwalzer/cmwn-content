var _ = require('lodash');

const paramBlacklist = [
    'bust'
];
var Utils = {
    transformQueriedToS3ParamEncoded: function (path, query) {
        var pathArr = path.split('.');
        var extension = pathArr.pop();

        _.each(query, (v, k) => {
            if (!~paramBlacklist.indexOf(k.toLowerCase())) {
                pathArr.push('_P_' + k + '__' + v);
            }
        });
        pathArr.push(extension);

        return pathArr.join('.');
    },
    transformS3ParamEncodedToQueried: function (s3Path) {
        //we assume here that there will be an extension
        var path = '';
        var extension = '';
        var existingParams = '';
        var paramlessS3Path = s3Path.split('?');
        var splitParams;
        var finalSegment;
        var result;

        if (~s3Path.indexOf('?')) {
            existingParams = paramlessS3Path.pop() + '&';
        }

        paramlessS3Path = paramlessS3Path.join('?');

        splitParams = paramlessS3Path.split('._P_');
        finalSegment = splitParams.pop();

        finalSegment = finalSegment.split('.');
        extension = finalSegment.pop();
        splitParams.push(finalSegment.join('.'));

        if (s3Path.indexOf('_P_') !== 0) {
            //the key does not begin with this
            path = splitParams.shift();
        }

        result = path + '.' + extension + _.reduce(splitParams, (acc, v) => acc + v.split('__').join('=') + '&', '?' + existingParams);

        //strip any trailing ampersands
        while (result.split('').pop() === '&') {
            result = result.slice(0, -1);
        }
        return result;

    }
};

module.exports = Utils;

