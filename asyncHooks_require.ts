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
    public functionName : string;
    public fileName : string;
    public lineNumber : number;
    public columnNumber : number;

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
    functionName: any;
    // typeName: string;
    // evalOrigin: string;
    fileName: string;
    lineNumber: number;
    columnNumber: number;
    // isEval: boolean;
    // isConstructor: boolean;
    // isNative: boolean;
    // isToplevel: boolean;

    constructor (frameInfo : FrameInfo) {
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
function parseStringStackTrace (stringTrace) : FrameInfo[] {
    let splitTrace = stringTrace.split('\n');
    let frameInfo : FrameInfo[] = [];
    for (let [i, v] of splitTrace.entries()) {
        if (i == 0) continue; // It's the 'Error:' part of the trace.

        let elements : string[] = v.trim().split(' ');
        let location = elements[elements.length - 1];
        if (i == splitTrace.length - 1) {
            // Do something special here.
            let locationSplit = location.split(':');
            let n = locationSplit.length;
            let col = parseInt(locationSplit[n-1]);
            let line = parseInt(locationSplit[n-2]);
            let file = locationSplit[n-3];

            frameInfo.push(new FrameInfo('', file, line, col));
        } else {
            location = location.substr(1, location.length - 2);
            let locationSplit = location.split(':');

            let functionName = '';
            // Get the middle parts to stitch together a name.
            if (elements.length > 2) {
                for (let j = 1; j < elements.length - 1; j++) {
                    functionName += ' ' + elements[j];
                }
            }

            if (locationSplit.length < 3) {
                // It's anonymous.
                frameInfo.push(new FrameInfo(functionName, '', -1, -1));
            } else {
                let n = locationSplit.length;
                let col = parseInt(locationSplit[n-1]);
                let line = parseInt(locationSplit[n-2]);
                let file = locationSplit[n-3];
                frameInfo.push(new FrameInfo(functionName, file, line, col));
            }
        }
    }
    return frameInfo;
}
function stackTrace (skip) : Frame[] {
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
    const obj : any = {};
    Error.captureStackTrace(obj, stackTrace);
    const structuredStackTrace = obj.stack;

    // extract data
    let frameInfo = parseStringStackTrace(structuredStackTrace);
    const frames : Frame[] = frameInfo.map((frameInfo) => new Frame(frameInfo));

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
