import { createApp } from './app.js';
import { config } from './config.js';

createApp().listen(config.port, () => {
  console.log(`PICT ERP running at http://localhost:${config.port}`);
});
