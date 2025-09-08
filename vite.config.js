import configProd from './vite/config.prod.mjs';
import configDev from './vite/config.dev.mjs';

export default ({ mode }) => {
  return mode === 'production' ? configProd : configDev;
};
