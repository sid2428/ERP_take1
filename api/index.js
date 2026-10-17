// Vercel serverless entry point: every request is routed here (see vercel.json) and handled by
// the compiled Express app. `npm run build` produces dist/ before this function is bundled.
import { createApp } from '../dist/src/app.js';

export default createApp();
