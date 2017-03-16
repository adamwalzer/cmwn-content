var gulp = require('gulp');
var eslint = require('gulp-eslint');
var fs = require('fs');
var eslintConfigJs = JSON.parse(fs.readFileSync('./.eslintrc'));
var eslintConfigTest = JSON.parse(fs.readFileSync('./.eslintrc_test'));
var eslintConfigConfig = JSON.parse(fs.readFileSync('./.eslintrc_config'));
var _ = require('lodash');
var zip = require('gulp-zip');

/*
___  ______  ______  ______  ______  ______  ______  ______  ______  ______  ______  ______  ______  ___
 __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__
(______)(______)(______)(______)(______)(______)(______)(______)(______)(______)(______)(______)(______)
                                    #1 Build Functions
___  ______  ______  ______  ______  ______  ______  ______  ______  ______  ______  ______  ______  ___
 __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__
(______)(______)(______)(______)(______)(______)(______)(______)(______)(______)(______)(______)(______)
*/

/*
___  ______  ______  ______  ______  ______  ______  ______  ______  ______  ______  ______  ______  ___
 __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__
(______)(______)(______)(______)(______)(______)(______)(______)(______)(______)(______)(______)(______)
                                    #2 Task Definitions
___  ______  ______  ______  ______  ______  ______  ______  ______  ______  ______  ______  ______  ___
 __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__  __)(__
(______)(______)(______)(______)(______)(______)(______)(______)(______)(______)(______)(______)(______)
*/


var zipTheBuild = function () {
    return gulp.src(['build/**/*.*'])
        .pipe(zip('build.zip'))
        .pipe(gulp.dest('./'));
};

gulp.task('copy-config', function () {
    'use strict';
    return gulp.src(['conf/**/*.*']).pipe(gulp.dest('./build/conf'));
});

gulp.task('copy-modules', function () {
    'use strict';
    return gulp.src(['node_modules/**/*.*']).pipe(gulp.dest('./build/node_modules'));
});

gulp.task('copy-source', function () {
    'use strict';
    return gulp.src(['src/**/*.*']).pipe(gulp.dest('./build/src'));
});


gulp.task('build', ['copy-config', 'copy-modules', 'copy-source'], zipTheBuild);
gulp.task('default', ['lint']);

/*·.·´`·.·•·.·´`·.·•·.·´`·.·•·.·´Lint and Testing Tasks`·.·•·.·´`·.·•·.·´`·.·•·.·´`·.·•·.·´`·.·*/
gulp.task('lint', ['lint-js', 'lint-config']);

gulp.task('lint-js', function () {
    return gulp.src(['src/**/*.js', '!src/**/*.test.js'])
        // eslint() attaches the lint output to the eslint property
        // of the file object so it can be used by other modules.
        .pipe(eslint(eslintConfigJs))
        // eslint.format() outputs the lint results to the console.
        // Alternatively use eslint.formatEach() (see Docs).
        .pipe(eslint.format())
        // To have the process exit with an error code (1) on
        // lint error, return the stream and pipe to failAfterError last.
        .pipe(eslint.failAfterError());
});

gulp.task('lint-test', function () {
    return gulp.src(['src/**/*.test.js'])
        .pipe(eslint(_.defaultsDeep(eslintConfigTest, eslintConfigJs)))
        .pipe(eslint.format());
});

gulp.task('lint-config', function () {
    return gulp.src(['gulpfile.js', 'webpack.config.dev.js', 'webpack.config.prod.js'])
        .pipe(eslint(_.defaultsDeep(eslintConfigConfig, eslintConfigJs)))
        .pipe(eslint.format());
});
