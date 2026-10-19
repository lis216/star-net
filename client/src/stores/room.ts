import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import type { DeviceView } from '../types';
import { uid } from '../utils/uid';

let toastSeq = 1;

function loadNameMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem('starnet.names') || '{}');
  } catch {
    return {};
  }
}

export const useRoomStore = defineStore('room', () => {
  const joined = ref(false);
  const selfId = ref('');
  const key = ref('');
  const name = ref('');
  const clientId = ref(localStorage.getItem('starnet.clientId') || uid());
  const devices = ref<DeviceView[]>([]);
  const selectedId = ref('');
  const requests = ref<{ fromId: string; name: string }[]>([]);
  const joinError = ref('');
  const connected = ref(false);
  const toasts = ref<{ id: number; text: string }[]>([]);
  // 见过的设备名字缓存（持久化）：设备离线后历史消息/会话仍能显示名字
  const nameMap = reactive<Record<string, string>>(loadNameMap());

  localStorage.setItem('starnet.clientId', clientId.value);

  const self = computed(() => devices.value.find((d) => d.id === selfId.value));
  const selected = computed(() => devices.value.find((d) => d.id === selectedId.value));
  const onlineDevices = computed(() => devices.value.filter((d) => d.online));

  function rememberName(id: string, n: string): void {
    if (!id || !n || nameMap[id] === n) return;
    nameMap[id] = n;
    localStorage.setItem('starnet.names', JSON.stringify(nameMap));
  }

  function deviceName(id: string): string {
    if (id === selfId.value) return name.value;
    return devices.value.find((d) => d.id === id)?.name || nameMap[id] || '未知设备';
  }

  function upsertDevice(d: DeviceView): void {
    rememberName(d.id, d.name);
    const i = devices.value.findIndex((x) => x.id === d.id);
    if (i >= 0) devices.value[i] = d;
    else devices.value.push(d);
  }

  function markOffline(id: string): void {
    const d = devices.value.find((x) => x.id === id);
    if (d) d.online = false;
  }

  function removeDevice(id: string): void {
    devices.value = devices.value.filter((x) => x.id !== id);
    if (selectedId.value === id) selectedId.value = '';
  }

  function renameDevice(id: string, newName: string): void {
    rememberName(id, newName);
    const d = devices.value.find((x) => x.id === id);
    if (d) d.name = newName;
    if (id === selfId.value) {
      name.value = newName;
      localStorage.setItem('starnet.name', newName);
    }
  }

  function toast(text: string): void {
    const id = toastSeq++;
    toasts.value.push({ id, text });
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id);
    }, 3500);
  }

  function saveIdentity(k: string, n: string): void {
    key.value = k;
    name.value = n;
    localStorage.setItem('starnet.key', k);
    localStorage.setItem('starnet.name', n);
  }

  return {
    joined, selfId, key, name, clientId, devices, selectedId, requests,
    joinError, connected, toasts,
    self, selected, onlineDevices,
    deviceName, upsertDevice, markOffline, removeDevice, renameDevice, toast, saveIdentity, rememberName,
  };
});
