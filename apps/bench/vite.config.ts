import { strideApp } from '@stride-ts/devkit/vite';

export default strideApp(5182, { build: { rollupOptions: { input: ['index.html', 'gc.html', 'displacement.html', 'procedural.html', 'capabilities.html', 'memory.html'] } } });
