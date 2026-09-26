export default {
  // With `output: 'export'` below, a custom distDir names the exported folder
  // while Next keeps its build cache in .next; frontend_start.sh therefore
  // judges freshness by out/index.html itself.
  distDir: process.env.LOFAI_NEXT_DIST_DIR || '.next',
  reactStrictMode: true,
  // Every page is client-rendered and talks to the backend directly over its
  // WebSocket, so the app builds to plain files in out/. Serving those takes
  // one small static server instead of a Next.js server and its workers -
  // about 185MB less resident memory beside the model on an 8GB Mac.
  // Trailing slashes let a plain static server resolve /2 to /2/index.html.
  output: 'export',
  trailingSlash: true,
  webpack(config) {
    config.module.rules.push({
      test: /\.mp3$/,
      use: {
        loader: 'file-loader',
        options: {
          publicPath: '/_next/static/audio/',
          outputPath: 'static/audio/',
          name: '[name].[ext]',
          esModule: false,
        },
      },
    });
    return config;
  },
};
