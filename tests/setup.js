// Loaded by `node --import` before the tests: lets Node import .sql files as
// text, the way wrangler's [[rules]] block does for the Worker.
import { register } from 'node:module';

register('./sql-loader.js', import.meta.url);
