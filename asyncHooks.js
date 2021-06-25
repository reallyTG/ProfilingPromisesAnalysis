const async_hooks = require('async_hooks');
const fs = require('fs');
const util = require('util');

// the unix time of when this analysis begun
const time = Date.now();

// I/O function heuristic
let ioFunctions = [{fileName: "internal/util.js", functionName: "readFile"},
                   {fileName: "internal/util.js", functionName: "stat"}];
function isIO(frame) {
    return frame && frame.fileName && frame.functionName
        && ioFunctions.some(func => func.fileName == frame.fileName
                            && func.functionName == frame.functionName);
}

function isUserCode(frame) {
    return frame.fileName && frame.fileName.startsWith("/home/"); // TODO: better heuristic
}

// Map<AsyncID,
//     {source: string,
//      startTime: BigInt,
//      endTime: BigInt,
//      elapsedTime: BigInt}
// promise information
//
let promiseInfo = [];

function debug(...args) {
    // Use a function like this one when debugging inside an AsyncHooks callback
    fs.writeFileSync('log.out', `${util.format(...args)}\n`, { flag: 'a' });
}

//
// The following are the callbacks that can be passed to createHook().
//



// init is called during object construction. The resource may not have
// completed construction when this callback runs, therefore all fields of the
// resource referenced by "asyncId" may not have been populated.
function init(asyncId, type, triggerAsyncId, resource) {
    if (type === "PROMISE") {
        let trace = stackTrace(/*2*/3);
        debug(`init@ asyncId=${asyncId} type=${type} triggerAsyncId=${triggerAsyncId} resource=${resource} trace=${JSON.stringify(trace, undefined, 4)}`);

        let asyncContext = trace[0];

        // if we could identify the user code that called us
        if (asyncContext) {
            // the "catch" function is weird. 
            // Need to look one more up the stack.
            if (asyncContext.functionName === 'catch' && trace.length > 1) {
            	asyncContext = trace[1];
            }

            // create entry in promiseInfo
            let userCode = isUserCode(asyncContext);
            let filename = userCode? asyncContext.fileName.substring(/*142*//*210*/0) : asyncContext.fileName;
            promiseInfo[asyncId] = {
                source: `(${filename}:${asyncContext.lineNumber}:${asyncContext.columnNumber}:${asyncContext.lineNumber}:${asyncContext.columnNumber})`, // TODO: fix this hack for normalization
                startTime: process.hrtime.bigint(),
                endTime: undefined,
                elapsedTime: undefined,
                asyncId: asyncId,
                triggerAsyncId: triggerAsyncId,
//                 asyncId: triggerAsyncId,
//                 triggerAsyncId: asyncId,
                io: isIO(asyncContext),
                userCode: userCode
            };
        } else {
            debug("couldn't identify relevant frame!");
        }

    }
}

// Before is called just before the resource's callback is called. It can be
// called 0-N times for handles (e.g. TCPWrap), and will be called exactly 1
// time for requests (e.g. FSReqCallback).
function before(asyncId) { }

// After is called just after the resource's callback has finished.
function after(asyncId) { }

// Destroy is called when an AsyncWrap instance is destroyed.
function destroy(asyncId) { }

// promiseResolve is called only for promise resources, when the
// `resolve` function passed to the `Promise` constructor is invoked
// (either directly or through other means of resolving a promise).
function promiseResolve(asyncId) {
    debug(`promiseResolve@ asyncId=${asyncId}`);
    if (asyncId in promiseInfo) {
        promiseInfo[asyncId].endTime = process.hrtime.bigint();
    }
}

// from https://github.com/nearform/node-clinic-bubbleprof/blob/c4341f7be0896a83d5d6a4980cdaf1ba0a423bbb/collect/stack-trace.js#L51
function noFormat (errorObject, structuredStackTrace) {
    return structuredStackTrace;
}
class Frame {
    constructor (frame) {
        this.functionName = frame.getFunctionName() || '';
        this.typeName = '';
        this.evalOrigin = '';
        this.fileName = '';
        this.lineNumber = 0;
        this.columnNumber = 0;

        this.isEval = false;
        this.isConstructor = false;
        this.isNative = false;
        this.isToplevel = false;

        // Only one of these can be true. Test in the order of most likely.
        if (frame.isToplevel()) {
            this.isToplevel = true;
        } else if (frame.isConstructor()) {
            this.isConstructor = true;
        } else if (frame.isNative()) {
            this.isNative = true;
        } else {
            this.typeName = frame.getTypeName();
        }

        // Get source
        this.fileName = frame.getFileName() || '';
        this.lineNumber = (
            frame.getLineNumber() || /* istanbul ignore next: no known case */ 0
        );
        this.columnNumber = (
            frame.getColumnNumber() || /* istanbul ignore next: no known case */ 0
        );

        // If the fileName is empty, the error could be from an eval. Check
        // frame.isEval() to be sure. We check the `this.fileName` first to avoid
        // the overhead from `frame.isEval()`
        if (this.fileName === '' && frame.isEval()) {
            this.isEval = true;
            this.evalOrigin = frame.getEvalOrigin();
        }
    }
}
function stackTrace (skip) {
    // overwrite stack trace limit and formatting
    const restoreFormat = Error.prepareStackTrace;
    const restoreLimit = Error.stackTraceLimit;
    Error.prepareStackTrace = noFormat;
    Error.stackTraceLimit = Infinity;

    // collect stack trace
    const obj = {};
    Error.captureStackTrace(obj, stackTrace);
    const structuredStackTrace = obj.stack;

    // restore limit and formatting
    Error.prepareStackTrace = restoreFormat;
    Error.stackTraceLimit = restoreLimit;

    // extract data
    const frames = structuredStackTrace.map((frame) => new Frame(frame));

    // Don't include async_hooks frames
    return frames.slice(skip).filter(function (frame) {
        return (frame.fileName !== 'async_hooks.js' &&
                frame.fileName !== 'internal/async_hooks.js');
    });
}

// returns the user frame that initiated this promise.
// returns undefined if we can't find one.
/*function identifyRelevantFrame(trace) {
    for (frame of trace) {
        if (frame.fileName && frame.fileName.startsWith("/home/")) { // TODO: better heuristic
            return frame;
        }
    }

    return undefined;
    }*/

// propagate IO status on promises in promiseInfo.
// should be called after the analysis completes and full
// information is available.
function propagateIO() {
    debug("io propagation time");
    // start by gathering list of promises that AREN'T directly io.
    let noIO = promiseInfo.filter(info => !info.io);
    debug(`# of non io promises: ${noIO.length}`);

    // loop through these promises
    for (promise of noIO) {
        // walk down its descendants and propagate IO status
        propagateIOPromise(promise);
    }
}

// promiseInfo -> boolean (IO status)
function propagateIOPromise(promise) {
    debug(`processing promise with async id ${promise.asyncId}`);
    // if this promise is already IO, we don't need to propagate any
    // status to its descendants.
    if (promise.io) {
        return true;
    }

    // this promise isn't directly IO
    // are its descendants? if so, it should be IO
    let descendants = promiseInfo.filter(info => info.triggerAsyncId == promise.asyncId);
    if (descendants.some(info => propagateIOPromise(info))) {
        debug(`propagating IO status to promise with async id ${promise.asyncId}`);
        promise.io = true;
        return true;
    } else {
        // neither promise nor descendants are IO
        // return false for no IO
        return false;
    }
}

function endExecution() {
    // save analysis results to file
    const fs = require('fs');

    propagateIO();

    let promises = {};

    let promisesProcessed = 0;
    promiseInfo.forEach((value, index) => {
        promises[promisesProcessed++] = value;
    });


    let results = {
        promises: promises
    };

    // remove promises that have no endTime
    // also computed elapsedTime
    for (key in results.promises) {
        let promiseInfo = results.promises[key];
        if (!promiseInfo.hasOwnProperty("endTime") || promiseInfo.endTime === undefined) {
            // remove promise
            results.promises[key] = undefined;
        } else {
            // compute its elapsedTime
            promiseInfo.elapsedTime = promiseInfo.endTime - promiseInfo.startTime;
        }
    }

    fs.writeFileSync(`results-${time}.json`,
                     JSON.stringify(results, function (key, value) {
                         if (typeof(value) === "bigint") {
                             return value.toString();
                         } else {
                             return value;
                         }
                     },
                                    4));
}

// Create a new AsyncHook instance. All of these callbacks are optional.
const asyncHook =
      async_hooks.createHook({ init, before, after, destroy, promiseResolve });

// Allow callbacks of this AsyncHook instance to call. This is not an implicit
// action after running the constructor, and must be explicitly run to begin
// executing callbacks.
asyncHook.enable();

// set up analysis end
process.on('exit', exitCode => {
    debug(`exit@ ${exitCode}`);
    endExecution();
});

// figure out what program we need to execute
// get rid of this analysis in argv
process.argv.splice(1, 1);
process.argc--;

// resolve target script path
// (if it's not an absolute path, assume it's relative)
if (process.argv[1][0] != '/') {
	  process.argv[1] = process.cwd() + '/' + process.argv[1];
}

// run target script
console.log(`running script: ${process.argv[1]}`);
require(process.argv[1]);

// good luck to the analysis!
