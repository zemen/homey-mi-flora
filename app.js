'use strict';

const Homey = require('homey');

const DATA_SERVICE_UUID = '0000120400001000800000805f9b34fb';
const DATA_CHARACTERISTIC_UUID = '00001a0100001000800000805f9b34fb';
const FIRMWARE_CHARACTERISTIC_UUID = '00001a0200001000800000805f9b34fb';
const REALTIME_CHARACTERISTIC_UUID = '00001a0000001000800000805f9b34fb';

const MAX_RETRIES = 3;

async function asyncForEach(array, callback) {
    for (let index = 0; index < array.length; index++) {
        await callback(array[index], index, array);
    }
}

module.exports = class HomeyMiFlora extends Homey.App {

    /**
     * init the app
     */
    onInit() {
        console.log('Successfully init HomeyMiFlora version: %s', this.homey.manifest.version);

        this.deviceSensorUpdated = this.homey.flow.getDeviceTriggerCard('device_sensor_updated');
        this.globalSensorUpdated = this.homey.flow.getTriggerCard('sensor_updated');
        this.deviceSensorChanged = this.homey.flow.getDeviceTriggerCard('device_sensor_changed');
        this.globalSensorChanged = this.homey.flow.getTriggerCard('sensor_changed');
        this.globalSensorTimeout = this.homey.flow.getTriggerCard('sensor_timeout');
        this.globalSensorThresholdMinExceeds = this.homey.flow.getTriggerCard('sensor_threshold_min_exceeds');
        this.deviceSensorThresholdMinExceeds = this.homey.flow.getDeviceTriggerCard('device_sensor_threshold_min_exceeds');
        this.globalSensorThresholdMaxExceeds = this.homey.flow.getTriggerCard('sensor_threshold_max_exceeds');
        this.deviceSensorThresholdMaxExceeds = this.homey.flow.getDeviceTriggerCard('device_sensor_threshold_max_exceeds');
        this.globalSensorOutsideThreshold = this.homey.flow.getTriggerCard('sensor_outside_threshold');
        this.deviceSensorOutsideThreshold = this.homey.flow.getDeviceTriggerCard('device_sensor_outside_threshold');

        if (!this.homey.settings.get('updateInterval')) {
            this.homey.settings.set('updateInterval', 15)
        }
    }

    /**
     * connect to the sensor, update data and disconnect
     *
     * @param device MiFloraDevice
     *
     * @returns {Promise.<MiFloraDevice>}
     */
    async handleUpdateSequence(device) {

        let disconnectPeripheral = async () => {
            console.log('disconnectPeripheral not registered yet')
        };

        try {
            console.log('handleUpdateSequence');
            let updateDeviceTime = new Date();

            console.log('find');
            const advertisement = await this.homey.ble.find(device.getAddress(), 10000).then(function (advertisement) {
                return advertisement;
            });

            console.log('distance = ' + this.calculateDistance(advertisement.rssi) + ' meter');

            console.log('connect');
            const peripheral = await advertisement.connect();

            disconnectPeripheral = async () => {
                try {
                    console.log('try to disconnect peripheral')
                    if (peripheral.isConnected) {
                        console.log('disconnect peripheral')
                        return await peripheral.disconnect()
                    }
                } catch (err) {
                    throw new Error(err);
                }
            };

            const services = await peripheral.discoverServices();

            console.log('dataService');
            const dataService = await services.find(service => service.uuid === DATA_SERVICE_UUID);
            if (!dataService) {
                throw new Error('Missing data service');
            }
            const characteristics = await dataService.discoverCharacteristics();

            // get realtime
            console.log('realtime');
            const realtime = await characteristics.find(characteristic => characteristic.uuid === REALTIME_CHARACTERISTIC_UUID);
            if (!realtime) {
                throw new Error('Missing realtime characteristic');
            }
            await realtime.write(Buffer.from([0xA0, 0x1F]));

            // get data
            console.log('data');
            const data = await characteristics.find(characteristic => characteristic.uuid === DATA_CHARACTERISTIC_UUID);
            if (!data) {
                throw new Error('Missing data characteristic');
            }
            console.log('DATA_CHARACTERISTIC_UUID::read');
            const sensorData = await data.read();

            let sensorValues = {
                'measure_temperature': sensorData.readUInt16LE(0) / 10,
                'measure_luminance': sensorData.readUInt32LE(3),
                'flora_measure_fertility': sensorData.readUInt16LE(8),
                'flora_measure_moisture': sensorData.readUInt16BE(6)
            }
            console.log(sensorValues);

            await asyncForEach(device.getCapabilities(), async (characteristic) => {
                if (sensorValues.hasOwnProperty(characteristic)) {
                    device.updateCapabilityValue(characteristic, sensorValues[characteristic]);
                }
            });

            // get firmware
            const firmware = characteristics.find(characteristic => characteristic.uuid === FIRMWARE_CHARACTERISTIC_UUID);
            if (!firmware) {
                disconnectPeripheral();
                throw new Error('Missing firmware characteristic');
            }
            console.log('FIRMWARE_CHARACTERISTIC_UUID::read');
            const firmwareData = await firmware.read();

            const batteryValue = parseInt(firmwareData.toString('hex', 0, 1), 16);
            const batteryValues = {
                'measure_battery': batteryValue
            };

            await asyncForEach(device.getCapabilities(), async (characteristic) => {
                if (batteryValues.hasOwnProperty(characteristic)) {
                    device.updateCapabilityValue(characteristic, batteryValues[characteristic]);
                }
            });

            let firmwareVersion = firmwareData.toString('ascii', 2, firmwareData.length);

            await device.setSettings({
                firmware_version: firmwareVersion,
                last_updated: new Date().toISOString(),
                uuid: device.getData().uuid
            });

            console.log({
                firmware_version: firmwareVersion,
                last_updated: new Date().toISOString(),
                uuid: device.getData().uuid,
                battery: batteryValue
            });

            console.log('call disconnectPeripheral');
            await disconnectPeripheral();

            console.log('Device sync complete in: ' + (new Date() - updateDeviceTime) / 1000 + ' seconds');

            return device;
        } catch (error) {
            await disconnectPeripheral();
            throw error;
        }
    }

    /**
     * update the devices one by one
     *
     * @param devices MiFloraDevice[]
     *
     * @returns {Promise.<MiFloraDevice[]>}
     */
    async updateDevices(devices) {
        console.log(' ')
        console.log(' ');
        console.log(' ');
        console.log(' ');
        console.log('-----------------------------------------------------------------');
        console.log('| New update sequence ');
        console.log('-----------------------------------------------------------------');
        return await devices.reduce((promise, device) => {
            return promise
                .then(() => {
                    console.log('reduce');
                    device.retry = 0;
                    return this.homey.app.updateDevice(device)
                }).catch(error => {
                    console.log(error);
                });
        }, Promise.resolve());
    }

    /**
     * update the devices one by one
     *
     * @param device MiFloraDevice
     *
     * @returns {Promise.<MiFloraDevice>}
     */
    async updateDevice(device) {

        console.log('#########################################');
        console.log('# update device: ' + device.getName());
        console.log('# firmware: ' + device.getSetting('firmware_version'));
        console.log('#########################################');

        console.log('call handleUpdateSequence');

        if (device.retry === undefined) {
            device.retry = 0;
        }

        return await this.homey.app.handleUpdateSequence(device)
            .then(() => {
                device.retry = 0;

                return device;
            })
            .catch(error => {
                device.retry++;
                console.log('timeout, retry again ' + device.retry);
                console.log(error);

                if (device.retry < MAX_RETRIES) {
                    return this.homey.app.updateDevice(device)
                        .catch((error) => {
                            throw new Error(error);
                        });
                }

                this.homey.app.globalSensorTimeout.trigger({
                    'deviceName': device.getName(),
                    'reason': error
                })
                    .then(function () {
                        console.log('sending device timeout trigger');
                    })
                    .catch(function (error) {
                        console.error('Cannot trigger flow card sensor_timeout device: %s.', error);
                    });

                device.retry = 0;

                throw new Error('Max retries (' + MAX_RETRIES + ') exceeded, no success');
            });
    }

    /**
     * disconnect from peripheral
     *
     * @param driver MiFloraDriver
     *
     * @returns {Promise.<object[]>}
     */
    async discoverDevices(driver) {
        const version = this.homey.manifest.version;
        let devices = [];
        let index = 0;
        return this.homey.ble.discover()
            .then(advertisements => {
                advertisements.forEach(advertisement => {
                    if (advertisement.localName === driver.getMiFloraBleIdentification()) {
                        ++index;
                        devices.push({
                            id: advertisement.uuid,
                            name: driver.getMiFloraBleName() + " " + index,
                            data: {
                                id: advertisement.id,
                                uuid: advertisement.uuid,
                                address: advertisement.uuid,
                                name: advertisement.name,
                                type: advertisement.type,
                                version: "v" + version,
                            },
                            settings: driver.getDefaultSettings(),
                            capabilities: driver.getSupportedCapabilities(),
                        });
                    }
                });

                return devices;
            })
    }

    /**
     * @param rssi
     * @return {number}
     */
    calculateDistance(rssi) {
        const txPower = -59;
        const ratio = rssi / txPower;

        if (ratio < 1.0) {
            return Math.pow(ratio, 10);
        }

        return (0.19) * Math.pow(ratio, 8);
    }
}
