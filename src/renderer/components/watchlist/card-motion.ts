import { REPO_MOTION } from '../../lib/motion';

const easeOut: [number, number, number, number] = [0.22, 1, 0.36, 1];
const easeIn: [number, number, number, number] = [0.4, 0, 1, 1];

/** The former repo-card keyframes, including their intermediate offsets and timings. */
export function cardVariants(reduceMotion: boolean) {
  return {
    initial: { opacity: 0, y: -8, scale: 0.985 },
    enter: reduceMotion
      ? { opacity: 1, y: 0, scale: 1, transition: { type: 'tween' as const, duration: 0 } }
      : {
          opacity: [0, 1, 1],
          y: [-8, 1, 0],
          scale: [0.985, 1.004, 1],
          transition: {
            type: 'tween' as const,
            duration: REPO_MOTION.enterMs / 1000,
            times: [0, 0.68, 1],
            ease: easeOut,
          },
        },
    idle: { opacity: 1, y: 0, scale: 1, transition: { type: 'tween' as const, duration: 0 } },
    exit: reduceMotion
      ? {
          opacity: 0,
          y: 0,
          scale: 1,
          transition: { type: 'tween' as const, duration: REPO_MOTION.reducedMs / 1000, ease: 'linear' as const },
        }
      : {
          opacity: [1, 1, 0],
          y: [0, 1, -6],
          scale: [1, 0.998, 0.985],
          transition: {
            type: 'tween' as const,
            duration: REPO_MOTION.exitCardMs / 1000,
            times: [0, 0.22, 1],
            ease: easeIn,
          },
        },
  };
}

export function cardLayoutTransition(removing: boolean) {
  return {
    type: 'tween' as const,
    duration: (removing ? REPO_MOTION.exitLayoutMs : REPO_MOTION.layoutMs) / 1000,
    ease: removing ? easeIn : easeOut,
  };
}
