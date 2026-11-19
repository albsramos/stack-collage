// The artifact page loads React's UMD build, which has no jsx-runtime; map the automatic runtime onto createElement.
import * as React from 'react';

type Props = Record<string, unknown> & { children?: unknown };

export const Fragment = React.Fragment;

export function jsx(type: React.ElementType, props: Props, key?: React.Key) {
  const { children, ...rest } = props ?? {};
  if (key !== undefined) (rest as Props).key = key;
  return children === undefined ? React.createElement(type, rest) : React.createElement(type, rest, children as React.ReactNode);
}

export function jsxs(type: React.ElementType, props: Props, key?: React.Key) {
  const { children, ...rest } = props ?? {};
  if (key !== undefined) (rest as Props).key = key;
  return React.createElement(type, rest, ...((children as React.ReactNode[]) ?? []));
}
