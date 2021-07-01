// This is required for proper error detection via source maps.
// This might need additional configuration in the project itself, to support source maps.
// This doesn't seem to do anything?
// require('source-map-support').install();

const async_hooks = require('async_hooks');
const fs = require('fs');
const util = require('util');

// the unix time of when this analysis begun
const time = Date.now();
const output_file_name = `results-${time}.json`;

// Anti-mock.
let JSONStringify = JSON.stringify;

// I/O function heuristic
// TODO extend...
let ioFunctions = [{fileName: "/internal/util", functionName: "access"},
                   {fileName: "/internal/util", functionName: "appendFile"},
                   {fileName: "/internal/util", functionName: "chmod"},
                   {fileName: "/internal/util", functionName: "chown"},
                   {fileName: "/internal/util", functionName: "close"},
                   {fileName: "/internal/util", functionName: "copyFile"},
                   {fileName: "/internal/util", functionName: "createReadStream"},
                   {fileName: "/internal/util", functionName: "createWriteStream"},
                   {fileName: "/internal/util", functionName: "exists"},
                   {fileName: "/internal/util", functionName: "fchmod"},
                   {fileName: "/internal/util", functionName: "fchown"},
                   {fileName: "/internal/util", functionName: "fdatasync"},
                   {fileName: "/internal/util", functionName: "fstat"},
                   {fileName: "/internal/util", functionName: "fsync"},
                   {fileName: "/internal/util", functionName: "ftruncate"},
                   {fileName: "/internal/util", functionName: "futimes"},
                   {fileName: "/internal/util", functionName: "lchmod"},
                   {fileName: "/internal/util", functionName: "lchown"},
                   {fileName: "/internal/util", functionName: "lutimes"},
                   {fileName: "/internal/util", functionName: "link"},
                   {fileName: "/internal/util", functionName: "lstat"},
                   {fileName: "/internal/util", functionName: "mkdir"},
                   {fileName: "/internal/util", functionName: "mkdtemp"},
                   {fileName: "/internal/util", functionName: "open"},
                   {fileName: "/internal/util", functionName: "opendir"},
                   {fileName: "/internal/util", functionName: "read"},
                   {fileName: "/internal/util", functionName: "readdir"},
                   {fileName: "/internal/util", functionName: "readFile"},
                   {fileName: "/internal/util", functionName: "readlink"},
                   {fileName: "/internal/util", functionName: "readv"},
                   {fileName: "/internal/util", functionName: "realpath"},
                   {fileName: "/internal/util", functionName: "rename"},
                   {fileName: "/internal/util", functionName: "rmdir"},
                   {fileName: "/internal/util", functionName: "rm"},
                   {fileName: "/internal/util", functionName: "stat"},
                   {fileName: "/internal/util", functionName: "symlink"},
                   {fileName: "/internal/util", functionName: "truncate"},
                   {fileName: "/internal/util", functionName: "unlink"},
                   {fileName: "/internal/util", functionName: "unwatchFile"},
                   {fileName: "/internal/util", functionName: "utimes"},
                   {fileName: "/internal/util", functionName: "watch"},
                   {fileName: "/internal/util", functionName: "watchFile"},
                   {fileName: "/internal/util", functionName: "write"},
                   {fileName: "/internal/util", functionName: "writeFile"},
                   {fileName: "/internal/util", functionName: "writev"}
                ];

// let networkFunctions = [{filePattern: "node_modules/axios", functionName: "Axios.request"},
//                         {filePattern: "node_modules/node-fetch", functionName: "fetch"},
//                         {filePattern: "node_modules/superagent", functionName: "RequestBase.then"},
//                         {filePattern: "node_modules/got", functionName: "?????"}];

// Network function heuristics.
// These are mostly imported modules, and currently we will flag any
// use of the module for simplicity.
let networkFunctions = [{filePattern: "node_modules/axios"},
                        {filePattern: "node_modules/node-fetch"},
                        {filePattern: "node_modules/superagent"},
                        {filePattern: "node_modules/got"}];

function isIO(frame) {
    return frame && frame.fileName && frame.functionName
        && ioFunctions.some(func => func.fileName == frame.fileName
                            && func.functionName == frame.functionName);
}

function isNetwork(frame) {
    return frame && frame.fileName && networkFunctions.filter(nfp => 
        frame.fileName.indexOf(nfp.filePattern) > -1
    ).length > 0; 
}

function isUserCode(frame) {
    return frame.fileName && frame.fileName.startsWith("/home/"); // TODO: better heuristic
}

let initialized = [];

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

// init is called during object construction. The resource may not have
// completed construction when this callback runs, therefore all fields of the
// resource referenced by "asyncId" may not have been populated.
function init(asyncId, type, triggerAsyncId, resource) {
    // There are no duplicate initializations, either.
    // Maybe there is some confusion between the different instances that are running?
    if (initialized.indexOf(asyncId) > -1) {
        debug(`duplicate init@ asyncId=${asyncId}`);
    }
    initialized.push(asyncId);
    debug('initialized.length: ' + initialized.length);
    if (type === "PROMISE") {
        let trace = stackTrace(3 /*, used to be 2*/);
        debug(`init@ asyncId=${asyncId} type=${type} triggerAsyncId=${triggerAsyncId} resource=${resource} trace=${JSONStringify(trace, undefined, 4)}`);

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
                io: isIO(asyncContext),
                network: isNetwork(asyncContext),
                createdIn: time,
                functionName: asyncContext.functionName,
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
// function before(asyncId) { }

// After is called just after the resource's callback has finished.
// function after(asyncId) { }

// Destroy is called when an AsyncWrap instance is destroyed.
function destroy(asyncId) { }

// promiseResolve is called only for promise resources, when the
// `resolve` function passed to the `Promise` constructor is invoked
// (either directly or through other means of resolving a promise).
function promiseResolve(asyncId) {
    debug(`promiseResolve@ asyncId=${asyncId}`);
    if (asyncId in promiseInfo) {
        // First, we need to check if the promise already ended.
        let thisPromise = promiseInfo[asyncId];
        if (thisPromise.endTime) {
            debug(`repeatPromiseResolve@ asyncId=${asyncId}`);
            debug(`check: ${time - thisPromise.createdIn}`);
        }

        // Get the end time.
        thisPromise.endTime = process.hrtime.bigint();
        // Compute the elapsed time.
        thisPromise.elapsedTime = thisPromise.endTime - thisPromise.startTime;
        // Write the promise to the output file.
        logPromise(asyncId);
    }
}

function bigIntPrinter(key, value) {
    if (typeof(value) == "bigint")
	return value.toString();
    else
	return value;
}

function logPromise(asyncId) {
    // Log the promise to the output file.
    let writeMe = promiseInfo[asyncId];

    // Append the promise to the file.
    let toWrite = JSONStringify(writeMe, bigIntPrinter) + '\n';    
    fs.appendFileSync(output_file_name, toWrite, (err) => {
        if (err) throw err;
    });
}

// from https://github.com/nearform/node-clinic-bubbleprof/blob/c4341f7be0896a83d5d6a4980cdaf1ba0a423bbb/collect/stack-trace.js#L51
// function noFormat (errorObject, structuredStackTrace) {
//     return structuredStackTrace;
// }

class FrameInfo {
    functionName;
    fileName;
    lineNumber;
    columnNumber;

    constructor(functionName, fileName, lineNumber, columnNumber) {
        this.functionName = functionName;
        this.fileName = fileName;
        this.lineNumber = lineNumber;
        this.columnNumber = columnNumber;
    }
}

// This class is currently redundant, we can probably merge with above
// if things work out.
class Frame {
    functionName;
    // typeName: string;
    // evalOrigin: string;
    fileName;
    lineNumber;
    columnNumber;
    // isEval: boolean;
    // isConstructor: boolean;
    // isNative: boolean;
    // isToplevel: boolean;

    constructor (frameInfo) {
        this.functionName = frameInfo.functionName;
        this.fileName = frameInfo.fileName;
        this.lineNumber = frameInfo.lineNumber;
        this.columnNumber = frameInfo.columnNumber;
    }

    // This is the old way of doing things. This had to change since intercepting
    // the error message creation leads to issues re: source maps.
    // constructor (frame) {
    //     this.functionName = frame.getFunctionName() || '';
    //     this.typeName = '';
    //     this.evalOrigin = '';
    //     this.fileName = '';
    //     this.lineNumber = 0;
    //     this.columnNumber = 0;

    //     this.isEval = false;
    //     this.isConstructor = false;
    //     this.isNative = false;
    //     this.isToplevel = false;

    //     // Only one of these can be true. Test in the order of most likely.
    //     if (frame.isToplevel()) {
    //         this.isToplevel = true;
    //     } else if (frame.isConstructor()) {
    //         this.isConstructor = true;
    //     } else if (frame.isNative()) {
    //         this.isNative = true;
    //     } else {
    //         this.typeName = frame.getTypeName();
    //     }

    //     // Get source
    //     this.fileName = frame.getFileName() || '';
    //     this.lineNumber = (
    //         frame.getLineNumber() || /* istanbul ignore next: no known case */ 0
    //     );
    //     this.columnNumber = (
    //         frame.getColumnNumber() || /* istanbul ignore next: no known case */ 0
    //     );

    //     // If the fileName is empty, the error could be from an eval. Check
    //     // frame.isEval() to be sure. We check the `this.fileName` first to avoid
    //     // the overhead from `frame.isEval()`
    //     if (this.fileName === '' && frame.isEval()) {
    //         this.isEval = true;
    //         this.evalOrigin = frame.getEvalOrigin();
    //     }
    // }
}
function parseStringStackTrace (stringTrace) {
    let splitTrace = stringTrace.split('\n');
    let frameInfo = [];
    for (let [i, v] of splitTrace.entries()) {
        if (i == 0) continue; // It's the 'Error:' part of the trace.

        let elements = v.trim().split(' ');
        let location = elements[elements.length - 1];
        if (location[0] == '(') {
            location = location.substr(1);
        }
        if (location[location.length-1] == ')') {
            location = location.substr(0, location.length - 1);
        }
        if (i == splitTrace.length - 1) {
            // Do something special here.
            debug(';;;;; ' + location);
            let locationSplit = location.split(':');
            let n = locationSplit.length;
            let col = parseInt(locationSplit[n-1]);
            let line = parseInt(locationSplit[n-2]);
            let file = locationSplit[n-3];
            if (file && file[0] != '/')
                file = '/' + file;

            if (isNaN(col)) {
                debug('NaN ALERT: ' + location);
            }

            frameInfo.push(new FrameInfo('', file, line, col));
        } else {
            let locationSplit = location.split(':');

            let functionName = '';
            // Get the middle parts to stitch together a name.
            if (elements.length > 2) {
                for (let j = 1; j < elements.length - 1; j++) {
                    functionName += ' ' + elements[j];
                }
            }
            functionName = functionName.trim();

            if (locationSplit.length < 3) {
                // It's anonymous.
                frameInfo.push(new FrameInfo(functionName, '', -1, -1));
            } else {
                let n = locationSplit.length;
                let col = parseInt(locationSplit[n-1]);
                let line = parseInt(locationSplit[n-2]);
                let file = locationSplit[n-3];
                if (file && file[0] != '/')
                    file = '/' + file;

                if (isNaN(col)) {
                    debug('NaN ALERT: ' + location);
                }
                frameInfo.push(new FrameInfo(functionName, file, line, col));
            }
        }
    }
    return frameInfo;
}
function stackTrace (skip) {
    /*
     * We used to change the formatting of the stack trace, returning
     * the structured stack trace and dealing with that. Instead, we are now
     * looking at the string representation of the stack trace, because
     * the internal way of setting up the stack trace can make use of 
     * cached source maps, and the API is (AFAIK) inaccessible to us. Sure,
     * we could access it probably, but I have no idea how to.
     * ---------------------------------------------------------------------
     */

    // collect stack trace
    const obj = {};
    Error.captureStackTrace(obj, stackTrace);
    const structuredStackTrace = obj.stack;

    // extract data
    let frameInfo = parseStringStackTrace(structuredStackTrace);
    const frames = frameInfo.map((frameInfo) => new Frame(frameInfo));

    // Don't include async_hooks frames
    return frames.slice(skip).filter(function (frame) {
        return (frame.fileName !== 'async_hooks.js' &&
                frame.fileName !== 'internal/async_hooks.js');
    });
}

// Create a new AsyncHook instance. All of these callbacks are optional.
const asyncHook =
      async_hooks.createHook({ init, /* before, after,*/ destroy, promiseResolve });

// Allow callbacks of this AsyncHook instance to call. This is not an implicit
// action after running the constructor, and must be explicitly run to begin
// executing callbacks.
asyncHook.enable();

// Good luck, analysis!
