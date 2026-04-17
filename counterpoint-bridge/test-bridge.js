const { readFileSync } = require('fs');
console.log(process.cwd());
// Oh wait I can't require 'index.mjs' because it auto-starts. Let's just grep the logs.
