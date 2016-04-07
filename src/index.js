'use strict';

const Botkit = require('botkit');
const apiai = require('apiai');

const Entities = require('html-entities').XmlEntities;

const uuid = require('node-uuid');
const express = require('express');
const bodyParser = require('body-parser');
const request = require('request');
const Q = require('q');
const assert = require('assert');

const MongoClient = require('mongodb').MongoClient;

const slackUtils = new (require('./SlackUtils')).SlackUtils();

// console timestamps
require('console-stamp')(console, 'yyyy.mm.dd HH:MM:ss.l');

// -------------- configuration --------------------------
const DEV_CONFIG = false;

const BOTS_COLLECTION_NAME = 'bots';

const dbUrl = process.env.MONGOLAB_URI ||
    process.env.MONGOHQ_URL ||
    "mongodb://localhost/botsservice";

const restServicePort = process.env.PORT || 5000;

const CLIENT_ACCESS_TOKEN = process.env.APIAI_ACCESS_TOKEN;
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const LANGUAGE = process.env.LANG; 

// ----------- globals ------------------------------------

const bots = new Map();
const sessionIds = new Map();

var botsDb;
var restService;

var process_ambient = false;
var process_direct_message = true;
var process_direct_mention = true;
var process_mention = true;

const botkitController = Botkit.slackbot({
    debug: false
    //include "log: false" to disable logging
});

const decoder = new Entities();

// -------------------------------------------------------


botkitController.hears(['.*'], ['direct_message', 'direct_mention', 'mention', 'ambient'], (bot, message) => {
    if (message.type == 'message') {
        if (message.user == bot.identity.id) {
            // message from bot can be skipped
        }
        else if (message.text.indexOf("<@U") == 0 && message.text.indexOf(bot.identity.id) == -1) {
            // skip other users direct mentions
        }
        else {
            let requestText = decoder.decode(message.text);
            requestText = requestText.replace("’", "'");

            let channel = message.channel;
            let messageType = message.event;
            let botId = "<@" + bot.identity.id + ">";

            console.log('[%s] %s: %s', channel, messageType, requestText.substring(0, Math.min(20, requestText.length)));
            console.log("Bot id: ", botId);

            if (requestText.indexOf(botId) > -1) {
                requestText = requestText.replace(botId, '');
            }

            if (messageType == 'ambient' && !process_ambient) {
                return;
            }

            if (messageType == 'direct_message' && !process_direct_message) {
                return;
            }

            if (messageType == 'direct_mention' && !process_direct_mention) {
                return;
            }

            if (messageType == 'mention' && !process_mention) {
                return;
            }

            if (!sessionIds.has(channel)) {
                sessionIds.push(channel, uuid.v1());
            }

            if (bot.apiai_service) {

                bot.reply(message, {
                    type: 'typing'
                });

                var apiAiService = bot.apiai_service;

                console.log('[%s] %s', channel, "Start API.AI request");

                var request = apiAiService.textRequest(requestText,
                    {
                        sessionId: sessionIds[channel],
                        contexts: [
                            {
                                name: "generic",
                                parameters: {
                                    slack_user_id: message.user,
                                    slack_channel: channel
                                }
                            }
                        ]
                    });

                request.on('response', function (response) {
                    try {
                        console.log('[%s] %s', channel, 'API.AI Response received');

                        if (isDefined(response.result)) {

                            let botResponse = createSlackResponse(response);

                            if (botResponse) {
                                bot.reply(message, botResponse);
                            }

                        }
                    } catch (processingError) {
                        console.error('[%s] %s', channel, 'Error while processing api.ai response: ' + processingError);
                    }
                });

                request.on('error', function (error) {
                    console.error('[%s] %s', channel, error);
                });

                request.end();
            }
        }
    }
});

// Handle events related to the websocket connection to Slack
botkitController.on('rtm_open', function (bot) {
    console.log('** The RTM api just connected!');
});

botkitController.on('rtm_close', function (bot) {
    console.log('** The RTM api just closed');
    // you may want to attempt to re-open

    try {
        console.log('Trying to restart bot');

        // sometimes connection closing, so, we should restart bot
        if (bot.doNotRestart != true) {
            restartBot(bot);
        }

    } catch (err) {
        console.error('Restart bot failed', err);
    }
});


function isDefined(obj) {
    if (typeof obj == 'undefined') {
        return false;
    }

    if (!obj) {
        return false;
    }

    return obj != null;
}

function createSlackResponse(response) {
    let fulfillment = response.result.fulfillment;
    if (fulfillment) {
        let responseData = fulfillment.data;
        let responseSpeech = fulfillment.speech;

        if (DEV_CONFIG) {
            console.log(responseSpeech);
            console.log(JSON.stringify(responseData));
        }

        if (responseData) {
            // try to create slack message from data
            try {
                let dataObject = responseData;
                if (dataObject.slack) {
                    return dataObject.slack;
                }
            } catch (err) {
                console.error('[%s] %s', channel, "Parsing data json error: " + err);
            }
        }

        if (isDefined(responseSpeech)) {
            let botResponse = {
                text: responseSpeech
            };
            return botResponse;
        }
    }

    return "";
}

function startBots(db, filter) {
    console.log('Start bots by filter ', filter);
    if (!filter) {
        filter = {};
    }
    var botsCollection = db.collection(BOTS_COLLECTION_NAME);

    var defer = Q.defer();

    botsCollection.find(filter).toArray(function (err, docs) {
        if (err == null) {
            docs.forEach(function (entry) {
                try {
                    var bot = spawnBot(entry);
                    startBot(bot);
                } catch (startBotErr) {
                    console.error("Can't start bot instance: " + startBotErr);
                }
            });
            defer.resolve();
        } else {
            defer.reject(err);
        }
    });

    return defer.promise;
}

function spawnBot(botConfig) {
    var bot = botkitController.spawn(botConfig);
    return bot;
}

function trimToken(token) {
    return token.substring(0, 12) + '***';
}

function startBot(bot, callback) {

    var firstRun = bot.config.firstRun;

    let apiaiOptions = {
        language: LANGUAGE
    };
    
    bot.apiai_service = apiai(CLIENT_ACCESS_TOKEN, apiaiOptions);

    bot.startRTM(function (err) {
        if (err) {
            console.log('Error connecting bot to Slack:', err);
            if (callback) callback(err);
        }
        else {
            var token = bot.config.token;
            bots.push(token, bot);

            var trimmedToken = trimToken(token);
            console.log('Started bot for ' + trimmedToken);
            if (callback) callback(null);

            if (firstRun) {
                // bot just created, send message to author
                console.log('Start welcome message for %s', trimmedToken);
                bot.startPrivateConversation({user: bot.config.createdBy}, function (err, convo) {
                    if (err) {
                        console.log(err);
                    } else {
                        console.log('Sending welcome message for %s', trimmedToken);
                        convo.say("Hey! I'm your new bot. Great to meet you!");
                        convo.say('Now you can /invite me to a channel, so I can chat with other people as well!');
                        console.log('Welcome message for %s sent', trimmedToken);
                    }
                });
            }
        }
    });
}

function restartBot(bot) {
    bot.startRTM(function (err) {
        if (err) {
            console.error('Error connecting bot to Slack:', err);
        }
        else {
            var token = bot.config.token;
            var trimmedToken = trimToken(token);
            console.log('Started bot for %s', trimmedToken);
        }
    });
}

function persistBot(bot, callback) {
    console.log('Trying to persist bot');
    var botAccessToken = bot.config.token;
    var botsCollection = botsDb.collection(BOTS_COLLECTION_NAME);

    if (isDefined(botAccessToken)) {

        var doc = bot.config;
        doc.firstRun = false;

        botsCollection.updateOne({
                token: botAccessToken
            },
            doc,
            {
                upsert: true
            })
            .then(function () {
                console.log('Bot ' + botAccessToken.substring(0, 10) + '*** persisted');
                if (callback) callback(null);
            }, function (err) {
                console.error('Error while persisting bot ', err);
                if (callback) callback(err);
            });

    }
    else {
        console.error("Empty parameter botAccessToken");
    }
}

function createResponse(resp, code, message) {
    return resp.status(code).json({
        status: {
            code: code,
            message: message
        }
    });
}

function startRestService() {

    restService = express();
    restService.use(bodyParser.json());
    restService.all('*', (req, res, next) => {
        res.header("Access-Control-Allow-Origin", '*');
        res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, content-type, accept");
        next();
    });

    restService.get('/api/start', function (req, res) {
        
        var authCode = req.query.code;
        if (!authCode) {
            throw new Error("Empty authentication code");
        }

        var redirect_uri = req.body.redirect_uri;

        var opts = {
            client_id: SLACK_CLIENT_ID,
            client_secret: SLACK_CLIENT_SECRET,
            code: authCode,
            redirect_uri: redirect_uri
        };

        return slackUtils.oauth_access(opts)
            .then(function (auth) {

                log("Result from auth");
                log(auth);

                return slackUtils.auth_test(auth);
            })
            .then(function (test_result) {

                var identity = test_result.result;
                var auth = test_result.auth;

                log("Result from auth_test");
                log(identity);

                var botConfig = {
                    token: auth.bot.bot_access_token,
                    user_id: auth.bot.bot_user_id,
                    createdBy: identity.user_id,
                    team: identity.team,
                    team_id: identity.team_id,
                    firstRun: true,
                    apiai_active: true
                };

                if (bots.has(botConfig.token)) {
                    throw new Error("Bot already running in this team");
                }

                var bot = spawnBot(botConfig);
                startBot(bot);
                persistBot(bot);

                res.redirect("/success.html");

            })
            .fail(function (err) {
                console.error(err);
                res.redirect("/error.html?message=" + encodeURIComponent(err.toString()))
            })
            .done();
    });

    restService.post('/api/stop', function (req, res) {
        return createResponse(res, 400, "not implemented yet");
    });

    restService.get('/api/status', function (req, res) {
        return res.json({
            botsCount: bots.size,
            sessions: sessionIds.size,
            status: {
                code: 200,
                message: "bots count"
            }
        });
    });

    restService.listen(restServicePort, function () {
        console.log('Rest service ready on port ' + restServicePort);
    });
}

MongoClient.connect(dbUrl, function (err, db) {
    assert.equal(null, err);
    console.log("Connected to mongodb");

    botsDb = db;

    startBots(db); // start persisted bots
    startRestService(); // start rest service for new bots
});
