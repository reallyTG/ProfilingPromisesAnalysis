# Profiling Promises

This project is a profiling tool to detect inefficient promise usage in JavaScript.

Our dynamic analysis leverages the standard Node.js profiling API to observe promise execution.

### Quick Start -- Require

The recommended way to run the analysis for general use is to `require` it as part of test harness setup.
The analysis file for this is `asyncHooks_require.[jt]s`.
e.g., for mocha, do something like `mocha --require /path/to/asyncHooks_require.ts`.

TODO More thorough instructions.

### Quick Start -- Interceptor

To instrument any `node` command using the async hooks analysis, prefix your command with the path of `./async-hooks-interceptor/instrument`.

Here are some examples:

1. You want to instrument the file `promiseExample.js`.
   - To run this program normally, you would execute `node promiseExample.js`.
   - To instrument this program, you would execute `./async-hooks-interceptor/instrument node promiseExample.js`.
2. You want to run the test suite for a Node.js project, located at `./project`.
   - To run the test suite normally, you would execute `cd project; npm test`.
   - To instrument the test suite, you would execute `cd project; ../async-hooks-interceptor/instrument npm test`.


## Prior Reading

### Promises

https://developers.google.com/web/fundamentals/primers/promises


### Potentially Related Work

#### Visualization

1. SYNCTRACE: Visual Thread-Interplay Analysis
http://www.cs.tufts.edu/comp/250VIS/papers/SyncTrace.pdf
