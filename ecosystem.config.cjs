module.exports = {
  apps: [
    {
      name: 'ludoworld-server',
      cwd: '/root/ludo-server',
      script: 'src/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        PORT: 4444,
        NODE_ENV: 'production'
      }
    }
  ]
};
