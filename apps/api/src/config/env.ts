import 'dotenv/config'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing env: ${name}`)
  return value
}

export const env = {
  port: Number(process.env.API_PORT ?? process.env.PORT ?? 3001),
  openprojectUrl: required('OPENPROJECT_BASE_URL'),
  openprojectToken: required('OPENPROJECT_API_TOKEN'),
  openprojectInstanceId: required('OPENPROJECT_INSTANCE_ID'),
  dbPath: process.env.SQLITE_PATH ?? './runtime/app.sqlite',
  nodeEnv: process.env.NODE_ENV ?? 'development',
}
