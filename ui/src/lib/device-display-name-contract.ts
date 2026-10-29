/** Account-scoped cosmetic metadata. Never use names to establish identity or access. */
export type DeviceNameKind = 'browser' | 'bridge';
export interface DeviceNameTarget { kind: DeviceNameKind; id: string }
export interface DeviceDisplayName extends DeviceNameTarget { name: string }
export interface DeviceNamesResponse { names: DeviceDisplayName[]; eligible: DeviceNameTarget[] }
export interface SetDeviceNameRequest extends DeviceNameTarget { name: string | null }
export interface SetDeviceNameResponse { name: DeviceDisplayName | null }
export type DeviceNameErrorCode = 'unauthorized' | 'forbidden_origin' | 'invalid_request' | 'unknown_device' | 'conflict' | 'rate_limited' | 'storage_unavailable';
export interface DeviceNameErrorResponse { error: { code: DeviceNameErrorCode; message: string } }
export const DEVICE_DISPLAY_NAME_MAX_LENGTH = 80;
