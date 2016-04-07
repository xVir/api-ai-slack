'use strict';

const request = require('request');
const Q = require('q');

export class SlackUtils {
    
    call_api(command, options, cb) {
        log('** API CALL: ' + 'https://slack.com/api/' + command);
        request.post('https://slack.com/api/' + command, function (error, response, body) {
            console.log('Got response');
            
            if (error) {
                console.error(error);   
            }            
            
            if (!error && response.statusCode == 200) {
                var json = JSON.parse(body);
                if (json.ok) {
                    if (cb) cb(null, json);
                } else {
                    if (cb) cb(json.error, json);
                }
            } else {
                if (cb) cb(error);
            }
        }).form(options);
    }

    oauth_access(options) {
        console.log("Call oauth_access access");
        
        let deferred = Q.defer();
        this.call_api('oauth.access', options, function (error, auth) {
            if (error) {
                deferred.reject(new Error(error));
            } else {
                deferred.resolve(auth);
            }
        });
        return deferred.promise;
    }

    auth_test(auth) {
        var options = {token: auth.access_token};

        console.log("Call auth_test");
        
        let deferred = Q.defer();
        this.call_api('auth.test', options, function (error, result) {
            if (error) {
                deferred.reject(new Error(error));
            } else {
                deferred.resolve(
                    {
                        result: result,
                        auth: auth
                    }
                );
            }
        });
        return deferred.promise;
    }
}