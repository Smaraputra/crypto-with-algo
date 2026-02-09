export function useGSAP(callback: () => void) {
  // Execute callback synchronously in tests so DOM setup happens
  callback();
}
