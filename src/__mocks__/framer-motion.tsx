import React from 'react';

const MOTION_PROPS = new Set([
  'initial', 'animate', 'exit', 'transition', 'variants',
  'whileInView', 'viewport', 'pathLength', 'whileHover',
  'whileTap', 'whileFocus', 'whileDrag', 'onAnimationComplete',
]);

type MotionProps = Record<string, unknown> & {
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
};

function createMotionComponent(tag: string) {
  const Component = React.forwardRef<HTMLElement, MotionProps>(
    (props, ref) => {
      const filtered: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        if (!MOTION_PROPS.has(key)) {
          filtered[key] = value;
        }
      }
      return React.createElement(tag, { ...filtered, ref }, props.children as React.ReactNode);
    }
  );
  Component.displayName = `motion.${tag}`;
  return Component;
}

export const motion = new Proxy(
  {},
  {
    get(_target, prop: string) {
      return createMotionComponent(prop);
    },
  }
) as Record<string, React.ForwardRefExoticComponent<MotionProps>>;

export function LazyMotion({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export function AnimatePresence({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export const domAnimation = {};

export function useInView() {
  return true;
}
