import { defineConfig } from 'vite';
import { storyAssets } from './skills/children-storybook/scripts/story-assets.mjs';
export default defineConfig({ plugins: [storyAssets(process.cwd())] });
