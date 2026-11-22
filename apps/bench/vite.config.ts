import { strideApp } from '../../tools/lib/vite-app.ts';

export default strideApp(5182, { build: { rollupOptions: { input: ['index.html', 'gc.html', 'displacement.html', 'procedural.html', 'capabilities.html', 'memory.html'] } } });
