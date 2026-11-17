import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'Brightspace Downloader (TU Delft)',
    description:
      'Download the content of a Brightspace course as one .zip: files, links, announcements and grades.',
    permissions: ['storage', 'unlimitedStorage', 'scripting'],
    host_permissions: ['https://brightspace.tudelft.nl/*', 'https://mytimetable.tudelft.nl/*'],
  },
});
