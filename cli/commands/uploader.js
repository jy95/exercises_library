const supertest = require('supertest');
const {promises: fs, readFileSync} = require("fs");
const path = require("path");

// Auto generated tags
// if we want to map them to another name, we can do that easily ( Here : English TO French )
const AUTO_GENERATED_TAG_CATEGORIES = {
    "_PLATFORM_": "plateforme",
    "_SOURCE_": "source",
    "_COURSE_": "cours",
    "_EXERCISE-TYPE_": "type d'exercice",
    "_PROGRAMMING-LANGUAGE_": "langage",
    "_AUTHOR_": "auteur"
};

exports = module.exports = {
    "command": "uploader",
    "describe": "upload exercises to API using the generated file of crawler",
    "builder": function (y) {
        return y
            .option("apiBaseUrl", {
                type: "string",
                description: "URL of the API server",
                default: "localhost:3000"
            })
            .option("resultFile", {
                type: "string",
                description: "Absolute path to the generated file by crawler"
            })
            .option("user", {
                type: "string",
                description: "Absolute path to a JSON file that contains credentials like this : {\"email\": \"\", \"password\":  \"\" } "
            })
            .config("settings", "Absolute path to a JSON config file for uploader", (configPath) => {
                return JSON.parse(readFileSync(path.resolve(configPath), 'utf-8'));
            })
            .coerce("resultFile", (arg) => {
                return JSON.parse(readFileSync(path.resolve(arg), 'utf-8'));
            })
            .coerce("user", (arg) => {
                const user = JSON.parse(readFileSync(arg, 'utf-8'));
                if (["email", "password"].some(required_field => !user.hasOwnProperty(required_field))) {
                    throw new Error("Missing email/password in this JSON file")
                }
                return user;
            })
            .help()
            .argv;
    },
    "handler": function (argv) {
        send_to_API(argv, argv.resultFile)
            .then(() => console.log("Successfully insert the requested data"))
            .catch((err) => console.error(err));
    }
};

// Credits to https://gist.github.com/JamieMason/0566f8412af9fe6a1d470aa1e089a752
const groupBy = key => array =>
    array.reduce((objectsByKeyValue, obj) => {
        const value = obj[key];
        objectsByKeyValue[value] = (objectsByKeyValue[value] || []).concat(obj);
        return objectsByKeyValue;
    }, {});

async function send_to_API(argv, results) {

    const request = supertest(argv.apiBaseUrl);
    let response;

    try {
        response = await request
            .post("/auth/login")
            .set('Content-Type', 'application/json')
            .set('Accept', 'application/json')
            .send({
                "email": argv.user.email,
                "password": argv.user.password
            });

        // to generate more readable error
        handle_request_status(response);

        const JWT_TOKEN = response.body.token;

        const tags_categories = Object
            .values(AUTO_GENERATED_TAG_CATEGORIES)
            .concat(Object.values(results["own_categories"]));

        response = await request
            .post("/api/bulk_create_or_find_tag_categories")
            .set('Authorization', 'bearer ' + JWT_TOKEN)
            .set('Content-Type', 'application/json')
            .set('Accept', 'application/json')
            .send(tags_categories);

        // to generate more readable error
        handle_request_status(response);

        const tags_categories_ids = response.body;
        const tags_dictionary = groupBy("category")(tags_categories_ids);

        // If the user wants to upload files
        const files = results["exercises"]
            .map((exercise, index) => ({
                has_file: exercise.hasOwnProperty("file"),
                index: index,
                file: exercise.file
            }))
            .filter(exercise => exercise.has_file === true)
            .map(exercise => ({
                filename: path.basename(exercise.file),
                exercise: exercise.index,
                path: exercise.file
            }));

        // remove all not specified properties (to prevent a bad request with unknown object )
        const specified_properties = ["title", "description", "url", "tags"];

        // convert exercises to the given format in API
        const exercises = results["exercises"].map(exercise => {

            // handle tags conversion here to match what we have in API
            const tags = exercise["tags"].map(tag => {
                // Since crawler doesn't care about existent tags of not, they will be encoded as TagProposal
                return {
                    text: tag.text,
                    category_id: (tag.hasOwnProperty("autoGenerated") && tag.autoGenerated === true)
                        ? tags_dictionary[AUTO_GENERATED_TAG_CATEGORIES[tag["category_id"]]][0].id
                        : tags_dictionary[results["own_categories"][tag["category"]]][0].id
                }

            });
            // clean object from unspecified / not useful properties
            Object
                .keys(exercise)
                .filter(property => !specified_properties.includes(property))
                .forEach(property => {
                    delete exercise[property];
                });

            return Object.assign({}, exercise, {tags: tags});
        });

        // Upload that on API
        // if no files, use the simplest way
        response = (files.length === 0)
            ? await request
                .post("/api/bulk_create_exercises")
                .set('Authorization', 'bearer ' + JWT_TOKEN)
                .set('Content-Type', 'application/json')
                .send(exercises)
            : await bulk_insert_request(request, JWT_TOKEN, exercises, files);

        // to generate more readable error
        handle_request_status(response);

    } catch (e) {
        throw e;
    }
}

// To construct requests that uses multipart/form-data
async function bulk_insert_request(request, JWT_TOKEN, exercises, files) {
    // the most complicated thing :
    let requestInstance = request
        .post("/api/bulk_create_exercises")
        .set('Authorization', 'bearer ' + JWT_TOKEN);

    // Add all given files
    for (const file of files) {
        requestInstance.attach("files", file.path)
    }

    // Add the mapping between exercises and files
    files.forEach((file, index) => {
        const sub_field = "filesMapping[" + index + "]";
        requestInstance.field(sub_field + "[filename]", file.filename);
        requestInstance.field(sub_field + "[exercise]", file.exercise);
    });

    // Add the exercises metadata
    exercises.forEach((exercise, index) => {
        // since tags are more complicated to deal with, I must handle them separately
        const exercise_tags = exercise.tags;
        delete exercise.tags;

        const sub_field = "exercisesData[" + index + "]";
        // for other properties of exercise, it is pretty easy to handle them
        Object.entries(exercise).forEach(([key, value]) => {
            requestInstance.field(sub_field + "[" + key + "]", value);
        });

        // for tags, we have to use this ugly way because of supertest
        const sub_tag_field = sub_field + "[tags]";
        exercise_tags.forEach((tag, index) => {
            const sub_tag_field_index = sub_tag_field + "[" + index + "]";
            Object.entries(tag).forEach(([key, value]) => {
                requestInstance.field(sub_tag_field_index + "[" + key + "]", value);
            });
        });
    });

    return requestInstance;
}

// Custom error useful for debugging
class BetterError extends Error {
    constructor(url, status, message) {
        super(message);
        this.name = this.constructor.name;
        this.data = {
            url,
            status,
            message
        };
        Error.captureStackTrace(this, this.constructor);
    }
}

// to handle request failure
function handle_request_status(response) {
    if (response.status === 200) {
        return;
    } else {
        if (response.status >= 400) {
            throw new BetterError(response.request.url, response.status,response.body.message)
        }
    }
}