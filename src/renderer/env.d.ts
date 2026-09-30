/// <reference types="vite/client" />

import type { OctoBridge } from '../shared/types';

declare global {
  interface Window {
    octo: OctoBridge;
  }
}

export {};
