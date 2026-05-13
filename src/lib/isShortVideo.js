const https = require('https');


/**
 * Checks whether a video is a YouTube Short by issuing a HEAD request to
 * https://www.youtube.com/shorts/<videoId>. Real Shorts return 200;
 * regular videos redirect (302) to the standard /watch?v=... URL.
 * Mirrors Ruby's is_short? in GetChannelVideos.rb (commit f9f6784).
 */
module.exports = function isShortVideo(videoId) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (val) => {
      if (!resolved) {
        resolved = true;
        resolve(val);
      }
    };

    const req = https.request(
      {
        hostname: 'www.youtube.com',
        path: `/shorts/${videoId}`,
        method: 'HEAD',
        timeout: 5000,
      },
      (res) => done(res.statusCode === 200)
    );
    req.on('error', (e) => {
      console.log(`  short check failed for ${videoId}: ${e.message}`);
      done(false);
    });
    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
    req.end();
  });
};
