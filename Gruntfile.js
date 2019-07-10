module.exports = function(grunt) {
    grunt.initConfig({
        pkg: grunt.file.readJSON("package.json"),
        clean: ["output"],
        concat: {
            js: {
                files: {
                    "tmp/bimsurfer.js": [
                        "lib/jquery-ui-1.10.3.custom/js/jquery-ui-1.10.3.custom.js",
                        "lib/scenejs/*.js",
                        "api/*.js",
                        "api/Control/*.js",
                        "api/Types/*.js",
                        "api/Types/Light/*.js"
                    ]
                }
            }
        },
        uglify: {
            dist: {
                files: {
                    "output/bimsurfer.min.js": ["tmp/bimsurfer.js"]
                }
            }
        },
        cssmin: {
            options: {
                shorthandCompacting: false,
                roundingPrecision: -1
            },
            target: {
                files: {
                    "output/css/bimsurfer.min.css": ["css/*.css"]
                }
            }
        },
        copy: {
            main: {
                files: [
                    {
                        expand: true,
                        src: ["fonts/**", "img/**"],
                        dest: "output/"
                    },
                    {
                        src: ["images/*"],
                        dest: "images/"
                    },
                    {
                        src: ["*.html"],
                        dest: "output/"
                    },
                    {
                        src: ["plugin/**"],
                        dest: "output/"
                    }
                ]
            }
        },
        zip: {
            "using-cwd": {
                cwd: "output",
                src: ["output/**"],
                dest: "output/bimsurfer-V1-custom.zip"
            }
        }
    });

    grunt.loadNpmTasks("grunt-contrib-concat");
    grunt.loadNpmTasks("grunt-contrib-uglify");
    grunt.loadNpmTasks("grunt-contrib-cssmin");
    grunt.loadNpmTasks("grunt-contrib-copy");
    grunt.loadNpmTasks("grunt-contrib-clean");
    grunt.loadNpmTasks("grunt-zip");

    grunt.registerTask("default", ["clean", "concat", "uglify", "cssmin"]);
};
