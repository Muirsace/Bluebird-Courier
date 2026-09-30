/// <reference types="vite/client" />

import type { BluebirdCourierBridge } from '../../shared/types';

declare global {
  interface Window {
    bluebirdCourier: BluebirdCourierBridge;
  }
}

export {};
