module.exports = {
  apps: [
    {
      name: 'server',
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production'
      },
      error_file: 'logs/server-error.log',
      out_file: 'logs/server-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_memory_restart: '500M',
      watch: false,
      ignore_watch: ['node_modules', 'logs']
    },
    {
      name: 'worker',
      script: 'src/modules/jobs/worker.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
	APP_PUBLIC_BASE_URL: "https://photo.skislemt.beget.tech",
        GENAPI_CALLBACK_SECRET: "AZXqZ50dvmgVX6Da2BqhwyOQD4cEWB4KyF5GWfElzv7"
      },
      error_file: 'logs/worker-error.log',
      out_file: 'logs/worker-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_memory_restart: '300M',
      watch: false,
      ignore_watch: ['node_modules', 'logs']
    }
  ],
}
