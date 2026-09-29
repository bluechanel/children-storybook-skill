// The reader is the skill's renderer now: this app only supplies the story.
// Keeping one implementation means the exported video and the dev page cannot disagree.
import { mount } from '../skills/children-storybook/renderer/src/book.js';
import { bookContent } from './content.js';
import { narrationConfig } from './narration.js';

await mount({ bookContent, narrationConfig });
