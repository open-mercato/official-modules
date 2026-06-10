const path = require('path')

const reactDir = path.dirname(require.resolve('react/package.json'))
const reactDomDir = path.dirname(require.resolve('react-dom/package.json'))

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  watchman: false,
  rootDir: '.',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  moduleNameMapper: {
    '^react$': reactDir,
    '^react/(.*)$': `${reactDir}/$1`,
    '^react-dom$': reactDomDir,
    '^react-dom/(.*)$': `${reactDomDir}/$1`,
  },
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  transform: {
    '^.+\\.(t|j)sx?$': [
      'ts-jest',
      {
        tsconfig: {
          jsx: 'react-jsx',
        },
      },
    ],
  },
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.(ts|tsx)'],
  passWithNoTests: true,
  transformIgnorePatterns: [
    '/node_modules/(?!@open-mercato/)',
  ],
}
