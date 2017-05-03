const pkg = require('./package.json');
const pg = require('pg');
const program = require('commander');
const chalk = require('chalk');
const cheerio = require('cheerio');
const request = require('request');
const rp = require('request-promise');
const fs = require('fs');
const PleasantProgress = require('pleasant-progress');
const R = require('ramda');
const streamBuffers = require('stream-buffers');
const blake = require('blakejs');

const progress = new PleasantProgress();

const defaultConfig = pkg.defaultConfig;
const database = pkg.database;
const availableAct = ['createdb', 'createtbl', 'filldb', 'loaddb'];
const createImgTable = 'CREATE TABLE images(imgid bytea PRIMARY KEY, imgzip bytea, creat timestamp, last timestamp)';
const createRelTable = 'CREATE TABLE relations(imgid bytea PRIMARY KEY, imgrel json)';

program
    .version(pkg.version)
    .arguments('<act>')
    .option('-u --user [user]', 'set user', defaultConfig.user)
    .option('-p --password [password]', 'set password', defaultConfig.password)
    .option('-h --host [host]', 'set host', defaultConfig.host)
    .option('-p --port [port]', 'set port', defaultConfig.port)
    .action((act) => action = act);
program.parse(process.argv);
if (!(availableAct.includes(action))) {
    program.outputHelp();
    process.exit();
}

switch (action) {
    case 'createdb':
        createDataBase();
        break;
    case 'createtbl':
        createTables();
        break;
    case 'filldb':
        fillDatabase();
        break;
    case 'loaddb':
        loadFromDatabase();
        break;
    default:
        break;
}

function createDataBase() {
    const client = new pg.Client({
        user: program.user,
        database: 'postgres',
        password: program.password,
        host: program.host,
        port: program.port,
    });
    client.connect(function (err) {
        if (err) {
            error(err.message);
        } else {
            client.query(`CREATE DATABASE ${database}`)
                .then(() => success(`create database ${database} success`))
                .then(() => client.end())
                .catch((err) => {
                    error(err.message);
                    client.end();
                });
        }
    });
}

function createTables() {
    const client = new pg.Client({
        user: program.user,
        database: database,
        password: program.password,
        host: program.host,
        port: program.port,
    });
    client.connect(function (err) {
        client.query(createImgTable)
            .then(() => success(`create table 'images' success`))
            .then(() => client.query(createRelTable))
            .then(() => success(`create table 'relations' success`))
            .then(() => client.end())
            .catch((err) => {
                error(err.message);
                client.end();
            });
    });
}

function loadFromDatabase() {
    const client = new pg.Client({
        user: program.user,
        database: database,
        password: program.password,
        host: program.host,
        port: program.port,
    });
    client.connect(function (err) {
        if (err) {
            return error(err.message);
        }
        client.query('SELECT * FROM images LIMIT 1 OFFSET 0')
            .then((result) => fs.writeFileSync(`${result.rows[0].imgid.toString('hex')}.gif`, result.rows[0].imgzip))
            .then(() => client.query('SELECT * FROM relations LIMIT 1 OFFSET 0'))
            .then((result) => fs.writeFileSync(`${result.rows[0].imgid.toString('hex')}.json`, JSON.stringify(result.rows[0].imgrel)))
            .then(() => client.end())
            .catch((err) => {
                error(err.message);
                client.end();
            });
    });
}

async function fillDatabase() {
    let imgTag = '暴走漫画';
    let legalImgs = R.pipe(R.filter(filterImg), R.uniqBy((img) => img.id))(await getImgUrlList(imgTag));
    success(`${legalImgs.length} images available`);

    const client = new pg.Client({
        user: program.user,
        database: database,
        password: program.password,
        host: program.host,
        port: program.port,
    });

    function newImageItem(img, data) {
        let now = new Date();
        return new Promise((resolve, reject) => client.query('INSERT INTO images VALUES ($1, $2, $3, $4)', [
            // Buffer.from(img.id, 'hex'),
            img.hash,
            data,
            now,
            now
        ], (err, result) => err ? reject(err) : resolve(result)));
    }

    function newRelationItem(img, data) {
        return new Promise((resolve, reject) => client.query('INSERT INTO relations VALUES ($1, $2)', [
            // Buffer.from(img.id, 'hex'),
            img.hash,
            {
                peers: []
            }
        ], (err, result) => err ? reject(err) : resolve(result)));
    }

    let imgCount = 0;

    client.connect(async function (err) {
        if (err) {
            //connection error
            return error(err.message);
        }
        for (let img of legalImgs) {
            try {
                let imgData = await (fetchImgData(img));
                img.hash = Buffer.from(blake.blake2b(imgData));
                await client.query('BEGIN')
                    .then(() => newImageItem(img, imgData))
                    .then(() => newRelationItem(img, imgData))
                    .then(() => client.query('COMMIT'))
                    .then(() => imgCount++)
                    .catch(() => client.query('ROLLBACK'));
            } catch (err) {
                //error when fetching image data
                error(err.message);
            }
        }
        success(`${imgCount} images filled into database`);
        client.end();
    });
}

function fetchImgData(img) {
    return new Promise(async(resolve, reject) => {
        let stream = new streamBuffers.WritableStreamBuffer({
            initialSize: (100 * 1024),
            incrementAmount: (10 * 1024)
        });

        try {
            await new Promise((resolve, reject) => {
                request(`${pkg.imgRepo}${img.url}`)
                    .on('error', (err) => reject(err))
                    .on('end', () => resolve())
                    .pipe(stream);
            });
            stream.end();
            if (stream.size() < 100 * 1024) {
                resolve(stream.getContents());
            } else {
                reject(new Error('Image size exceeds size limit'));
            }
        } catch (err) {
            reject(err);
        }
    });
}

async function getImgUrlList(tag) {
    let i = 1,
        imgUrlList = [];

    while (true) {
        try {
            let resJson = await rp({
                uri: pkg.imgAPI,
                qs: {
                    page: i++,
                    step: pkg.imgChunkSize,
                    keyword: tag,
                    via: 4
                },
                transform: JSON.parse
            });
            if (resJson.hasOwnProperty('isOverTotalNum')) {
                success(`fetch ${resJson.modelList.length} image urls`);
                imgUrlList = imgUrlList.concat(resJson.modelList);
                if (resJson.isOverTotalNum === "true") {
                    break;
                }
            } else {
                throw new Error('response json has no [isOverTotalNum] property');
            }
        } catch (err) {
            error(err.message);
            break;
        }
    }

    return imgUrlList;
}

function filterImg(img) {
    return img.width < 240 &&
        img.height < 240 &&
        img.size < 100 * 1024;
}

function success(message) {
    console.log(chalk.green(message));
}

function error(message) {
    console.log(chalk.red(message));
}