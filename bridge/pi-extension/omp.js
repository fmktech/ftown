import { registerFtownPiExtension } from './ftown.js';

export default function ftownOmpExtension(omp) {
  registerFtownPiExtension(omp, { harness: 'omp' });
}
