import { expect, test } from 'claude-code/testing'

import { projectFor } from './band'

const MAP = '~/P/shop-app=shop-app;~/P/shop-pos=pos;~/.config=dotfiles'

test('folder map matches whole folder names only', () => {
  expect(projectFor('/h/P/shop-app', MAP, '/h')).toBe('shop-app')
  expect(projectFor('/h/P/shop-app/src/app', MAP, '/h')).toBe('shop-app')
  expect(projectFor('/h/P/shop-app-staging', MAP, '/h')).toBe(null)
  expect(projectFor('/h/P/shop-pos-old', MAP, '/h')).toBe(null)
  expect(projectFor('/h/.config/nvim', MAP, '/h')).toBe('dotfiles')
  expect(projectFor('/h', MAP, '/h')).toBe(null)
})
