#!/usr/bin/env node

require('yargs')
    .command(require('./commands/crawler'))
    .command(require('./commands/uploader'))
    .command(require("./commands/archiver"))
    .help()
    .argv;