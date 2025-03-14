/*
 * common.js: Common utility functions for requesting against Loggly APIs
 *
 * (C) 2010 Charlie Robbins
 * MIT LICENSE
 *
 */

//
// Variables for Bulk
//
var arrSize = 100,
    arrMsg = [],
    timerFunction = null,
    sendBulkInMs = 5000,
    maxSerializeDepth = 10;

// 
// Variables for buffer array
// 
var arrBufferedMsg = [],
    timerFunctionForBufferedLogs = null;

// 
// flag variable to validate authToken 
//
var isValidToken = true;

//
// attach event id with each event in both bulk and input mode
//
var bulkId = 1,
    inputId = 1;

//
// Variables for error retry
//
var numberOfRetries = 5,
    eventRetried = 2,
    sleepTimeMs,
    responseCode;

//
// Object to hold status codes
//
var httpStatusCode = {
  badToken: {
    message: 'Forbidden',
    code: 403
  },
  success: {
    message: 'Success',
    code: 200
  }
}

var axios = require('axios');
var common = exports;

//
// Core method that actually sends requests to Loggly.
// This method is designed to be flexible w.r.t. arguments
// and continuation passing given the wide range of different
// requests required to fully implement the Loggly API.
//
// Continuations:
//   1. 'callback': The callback passed into every node-loggly method
//   2. 'success':  A callback that will only be called on successful requests.
//                  This is used throughout node-loggly to conditionally
//                  do post-request processing such as JSON parsing.
//
// Possible Arguments (1 & 2 are equivalent):
//   1. common.loggly('some-fully-qualified-url', auth, callback, success)
//   2. common.loggly('GET', 'some-fully-qualified-url', auth, callback, success)
//   3. common.loggly('DELETE', 'some-fully-qualified-url', auth, callback, success)
//   4. common.loggly({ method: 'POST', uri: 'some-url', body: { some: 'body'} }, callback, success)
//
common.loggly = function () {
  var args = Array.prototype.slice.call(arguments),
      success = args.pop(),
      callback = args.pop(),
      responded,
      requestBody,
      headers,
      method,
      auth,
      proxy,
      isBulk,
      uri,
      bufferOptions,
      networkErrorsOnConsole;

  //
  // Now that we've popped off the two callbacks
  // We can make decisions about other arguments
  //
  if (args.length === 1) {
    if (typeof args[0] === 'string') {
      //
      // If we got a string assume that it's the URI
      //
      method = 'GET';
      uri    = args[0];
    }
    else {
      method      = args[0].method || 'GET';
      uri         = args[0].uri;
      requestBody = args[0].body;
      auth        = args[0].auth;
      isBulk      = args[0].isBulk;
      headers     = args[0].headers;
      proxy       = args[0].proxy;
      bufferOptions = args[0].bufferOptions;
      networkErrorsOnConsole = args[0].networkErrorsOnConsole;
    }
  }
  else if (args.length === 2) {
    method = 'GET';
    uri    = args[0];
    auth   = args[1];
  }
  else {
    method = args[0];
    uri    = args[1];
    auth   = args[2];
  }

  function onError(err) {
    if(!isValidToken){
  // eslint-disable-next-line no-undef
      console.log(err);
      return;
    }
    var arrayLogs = [];
    if(isBulk) {
      arrayLogs = requestOptions.body.split('\n');
    } else {
      arrayLogs.push(requestOptions.body);
    }
    storeLogs(arrayLogs);

    if (!responded) {
      responded = true;
      if (callback) { callback(err) }
    }
  }
  var requestOptions = {
    uri: (isBulk && headers['X-LOGGLY-TAG']) ? uri + '/tag/' + headers['X-LOGGLY-TAG'] : uri,
    method: method,
    headers: isBulk ? {} : headers || {},             // Set headers empty for bulk
    proxy: proxy,
    data: requestBody,
  };

  var requestOptionsForBufferedLogs = JSON.parse(JSON.stringify(requestOptions))

  if (auth) {
    // eslint-disable-next-line no-undef
    requestOptions.headers.authorization = 'Basic ' + Buffer.from(auth.username + ':' + auth.password, 'base64');
  }

  function popMsgsAndSend() {
    if (isBulk) {
      var bulk = createBulk(arrMsg);
      sendBulkLogs(bulk);
    } else {
      var input = createInput(requestBody);
      sendInputLogs(input);
    }
  }
  // eslint-disable-next-line no-unused-vars
  function createBulk(msgs) {
    var bulkMsg = {};
    bulkMsg.msgs = arrMsg.slice();
    bulkMsg.attemptNumber = 1;
    bulkMsg.sleepUntilNextRetry = 2 * 1000;
    bulkMsg.id = bulkId++;

    return bulkMsg;
  }
  // eslint-disable-next-line no-unused-vars
  function createInput(msgs) {
    var inputMsg = {};
    inputMsg.msgs = requestBody;
    requestOptions.body = requestBody;
    inputMsg.attemptNumber = 1;
    inputMsg.sleepUntilNextRetry = 2 * 1000;
    inputMsg.id = inputId++;

    return inputMsg;
  }
  function sendInputLogs(input) {
    try {
      axios(uri, requestOptions).then(function(res){
          responseCode = res.status;
          const body = res.data;

          if (responseCode === httpStatusCode.badToken.code) {
            isValidToken = false;
            return onError((new Error('Loggly Error (' + responseCode + '): ' + httpStatusCode.badToken.message)));
          }
          if (responseCode === httpStatusCode.success.code && input.attemptNumber >= eventRetried) {
            // eslint-disable-next-line no-undef
            if (networkErrorsOnConsole) console.log('log #' + input.id + ' sent successfully after ' + input.attemptNumber + ' retries');
          }
          if (responseCode === httpStatusCode.success.code) {
            success(res, body);
          } else {
            retryOnError(input, res);
          }
        })
        .catch(function(err) {
           return handleRequestError(input, err);
        });
    } catch (ex) {
      onError(ex);
    }
  }

  function handleRequestError(input, err) {
    // In rare cases server is busy
    if(err.cause && err.cause.code) {
      const code = err.cause.code;
      if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ESOCKETTIMEDOUT' || code === 'ECONNABORTED') {
        retryOnError(input, err);
      }
    } else {
      return onError(err);
    }
  }

  function sendBulkLogs(bulk) {
    //
    // Join Array Message with new line ('\n') character
    //
    if (arrMsg.length) {
      requestOptions.body = arrMsg.join('\n');
      arrMsg.length = 0;
    }
    try {
      // eslint-disable-next-line no-unused-vars
      axios(uri, requestOptions).then(function(res){
          const responseCode = res.status;
          if (responseCode === httpStatusCode.badToken.code) {
            isValidToken = false;
            return onError((new Error('Loggly Error (' + responseCode + '): ' + httpStatusCode.badToken.message)));
          }
          if (responseCode === httpStatusCode.success.code && bulk.attemptNumber >= eventRetried) {
            // eslint-disable-next-line no-undef
            if (networkErrorsOnConsole) console.log('log #' + bulk.id + ' sent successfully after ' + bulk.attemptNumber + ' retries');
          }
          if (responseCode !== httpStatusCode.success.code) {
            retryOnError(bulk, res);
          }
        })
        .catch(function(e) {
          return handleRequestError(bulk, e);
        })
    }
    catch (ex) {
      onError(ex);
    }
  }

  if (isBulk && isValidToken) {
    if (timerFunction === null) {
      // eslint-disable-next-line no-undef
      timerFunction = setInterval(function () {
        if (arrMsg.length) popMsgsAndSend();
        if (timerFunction && !arrMsg.length) {
          // eslint-disable-next-line no-undef
          clearInterval(timerFunction)
          timerFunction = null;
        }
      }, sendBulkInMs);
    }

    if (Array.isArray(requestBody)) {
      arrMsg.push.apply(arrMsg, requestBody);
    } else {
      arrMsg.push(requestBody);
    }

    if (arrMsg.length === arrSize) {
      popMsgsAndSend();
    }

    success()
  }
  else if (isValidToken) {
    if (requestBody) {
      popMsgsAndSend();
    }
  }

  //
  //function to retry sending logs maximum 5 times if any error occurs
  //
  function retryOnError(mode, response) {
    function tryAgainIn(sleepTimeMs) {
      // eslint-disable-next-line no-undef
      if (networkErrorsOnConsole) console.log('log #' + mode.id + ' - Trying again in ' + sleepTimeMs + '[ms], attempt no. ' + mode.attemptNumber);
      // eslint-disable-next-line no-undef
      setTimeout(function () {
        isBulk ? sendBulkLogs(mode) : sendInputLogs(mode);
      }, sleepTimeMs);
    }
    if (mode.attemptNumber >= numberOfRetries) {
      if (response.cause) {
        // eslint-disable-next-line no-undef
        if (networkErrorsOnConsole) console.error('Failed log #' + mode.id + ' after ' + mode.attemptNumber + ' retries on error = ' + response, response);
      } else {
        // eslint-disable-next-line no-undef
        if (networkErrorsOnConsole) console.error('Failed log #' + mode.id + ' after ' + mode.attemptNumber + ' retries on error = ' + response.statusCode + ' ' + response.statusMessage);
      }
    } else {
        if (response.cause) {
          // eslint-disable-next-line no-undef
          if (networkErrorsOnConsole) console.log('log #' + mode.id + ' - failed on error: ' + response);
        } else {
          // eslint-disable-next-line no-undef
          if (networkErrorsOnConsole) console.log('log #' + mode.id + ' - failed on error: ' + response.statusCode + ' ' + response.statusMessage);
        }
        sleepTimeMs = mode.sleepUntilNextRetry;
        mode.sleepUntilNextRetry = mode.sleepUntilNextRetry * 2;
        mode.attemptNumber++;
        tryAgainIn(sleepTimeMs)
      }
  }

  //
  // retries to send buffered logs to loggly in every 30 seconds
  //
  if (timerFunctionForBufferedLogs === null && bufferOptions) {
    // eslint-disable-next-line no-undef
    timerFunctionForBufferedLogs = setInterval(function () {
      if (arrBufferedMsg.length) sendBufferdLogstoLoggly();
        if (timerFunctionForBufferedLogs && !arrBufferedMsg.length) {
          // eslint-disable-next-line no-undef
          clearInterval(timerFunctionForBufferedLogs);
          timerFunctionForBufferedLogs = null;
        }
    }, bufferOptions.retriesInMilliSeconds);
  }


  function sendBufferdLogstoLoggly() {
    if (!arrBufferedMsg.length) return;
    var arrayMessage = [];
    var bulkModeBunch = arrSize;
    var inputModeBunch = 1;
    var logsInBunch = isBulk ? bulkModeBunch : inputModeBunch;
    arrayMessage = arrBufferedMsg.slice(0, logsInBunch);
    requestOptionsForBufferedLogs.body = isBulk ? arrayMessage.join('\n') : arrayMessage[0];
    // eslint-disable-next-line no-unused-vars
    axios(uri, requestOptionsForBufferedLogs)
      .then(function(res) {
        var statusCode = res.status;
        // eslint-disable-next-line no-undef
        if(statusCode === httpStatusCode.success.code) {
          arrBufferedMsg.splice(0, logsInBunch);
          sendBufferdLogstoLoggly();
        }
      })
      .catch(function() {
        return;
      })
    requestOptionsForBufferedLogs.body = '';
  }

//
// This function will store logs into buffer
//
  function storeLogs(logs) {
    if (!logs.length || !bufferOptions) return;
    var numberOfLogsToBeRemoved = (arrBufferedMsg.length + logs.length) - bufferOptions.size;
    if (numberOfLogsToBeRemoved > 0) arrBufferedMsg = arrBufferedMsg.splice(numberOfLogsToBeRemoved);
      arrBufferedMsg = arrBufferedMsg.concat(logs);
  }
};
//
// ### function serialize (obj, key)
// #### @obj {Object|literal} Object to serialize
// #### @key {string} **Optional** Optional key represented by obj in a larger object
// Performs simple comma-separated, `key=value` serialization for Loggly when
// logging for non-JSON values.
//
common.serialize = function (obj, key, depth) {
  if (obj === null) {
    obj = 'null';
  }
  else if (obj === undefined) {
    obj = 'undefined';
  }
  else if (obj === false) {
    obj = 'false';
  }

  if (typeof depth === 'number') {
    depth++;
  }
  else {
    depth = 1;
  }

  if (typeof obj !== 'object') {
    return key ? key + '=' + obj : obj;
  }

  var msg = '',
      keys = Object.keys(obj),
      length = keys.length;

  if (depth < maxSerializeDepth) {
    for (var i = 0; i < length; i++) {
      if (Array.isArray(obj[keys[i]])) {
        msg += keys[i] + '=[';
  
        for (var j = 0, l = obj[keys[i]].length; j < l; j++) {
          msg += common.serialize(obj[keys[i]][j], depth);
          if (j < l - 1) {
            msg += ', ';
          }
        }
  
        msg += ']';
      }
      else {
        msg += common.serialize(obj[keys[i]], keys[i], depth);
      }
  }

    if (i < length - 1) {
      msg += ', ';
    }
  }

  return msg;
};
