/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Needed so raw webhook body can be read for HMAC verification
    serverActions: { bodySizeLimit: '5mb' },
  },
}

module.exports = nextConfig
