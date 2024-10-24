import http from "k6/http";

import server from "../../config/eocs/servers.js";
import { env, getRandomInt, pickRandom, shuffle, addDays, addHours, addMinutes } from "../../lib/eocs-util.js";
import httpHeaders from "../../lib/http/headers.js";
import requestId from "../../lib/http/request-id.js";
import log from "../../lib/log.js";
import { id } from "../helpers.js";
import { login, logout } from "../login.js";
import { isOk, status200 } from "../../lib/checks.js";
import { group, sleep } from "k6";

const headers = httpHeaders().compressed().json().id(requestId());
const eocs = require("../../lib/eocs.js").eocs(server, headers);

export const options = {
	thresholds: {
		"http_req_duration{name:${}/vehicles,method:POST}": [],
		"http_req_duration{name:${}/vehicletypes,method:POST}": [],
	},
	summaryTrendStats: ["count", "min", "avg", "med", "p(75)", "p(90)", "p(95)", "p(99)", "max"],
};

export default function (data) {
	login();

	// 1. Adım: 10 tane araç oluştur
	const vehicleTypes = ensureVehicleTypes();
	const vehicleArray = ensureVehicles(vehicleTypes, 100);

	// 2. Adım: Incident oluştur
	const state = createIncident();

	// 3. Adım: Rastgele 3 araç rezerve et
	const shuffledVehicles = shuffle(vehicleArray);
	const reserveCount = getRandomInt(3, Math.min(10, vehicleArray.length)); // Rastgele 3 ile 10 arasında bir sayı al
	const reservedVehicles = shuffledVehicles.slice(0, reserveCount);
	reserveVehicles(state.incident, reservedVehicles);

	// 4. Adım: Rastgele 50 araç tahsis et ve alert et
	const allocatedVehicles = shuffledVehicles.slice(reserveCount, reserveCount + 50); // Rezerve edilen araçlardan sonraki 4 aracı tahsis et
	allocateVehicles(state.incident, allocatedVehicles, state);
	alertIncident(state.incident);

	// 5. Adım: geriye kalani tahsis et
	const remainingVehicles = shuffledVehicles.slice(reserveCount + 50);
	allocateVehicles(state.incident, remainingVehicles, state);

	// 6. Adım: Incident'ı complete ve finish et
	sleep(90);
	completeIncident(state.incident);
	finishIncident(state.incident);
	sleep(30);

	// 7. Adım: Tüm araçları sil
	deleteAllVehicles(vehicleArray);

	logout();
}

function ensureVehicles(vehicleTypes, count) {
	let vehicleArray = [];
	for (let i = 0; i < count; i++) {
		const vehicleType = pickRandom(vehicleTypes);
		const vehicleName = "snm" + `${vehicleType.name}${getRandomInt(1000, 9999)}`;
		const vehicleId = ensureVehicle(vehicleName, vehicleType);
		if (vehicleId) {
			vehicleArray.push(vehicleId);
		}
	}
	return vehicleArray;
}

function ensureVehicleTypes() {
	return Object.keys(vehicleTypeEntities).map(ensureVehicleType);
}

function ensureVehicleType(type) {
	let vehicleType = http.get(server.api`vehicletypes?name=${encodeURIComponent(type)}`, { headers }).json("elements.0");
	if (!vehicleType) {
		log.debug(`Creating vehicle-type: ${type} ...`);
		vehicleType = http
			.post(
				server.api`vehicletypes`,
				JSON.stringify({
					name: type,
					comment: "k6",
					icon: vehicleTypeEntities[type].icon,
				}),
				{ headers }
			)
			.json();
		log.info(`Created vehicle-type: ${type}.`);
	}
	return vehicleType;
}

export function ensureVehicle(name, type) {
	let vehicle = http.get(server.api`vehicles?name=${encodeURIComponent(name)}`, { headers }).json("elements.0");

	if (!vehicle) {
		log.debug(`Creating vehicle: ${name} ...`);
		vehicle = http
			.post(
				server.api`vehicles`,
				JSON.stringify({
					name: name,
					comment: "snm",
				}),
				{
					headers,
				}
			)
			.json();
		log.info(`Created vehicle: ${name}.`);

		let vehicleId = vehicle.id;
		log.info(`Vehicle ID: ${vehicleId}`);

		// Araç tipini atama
		http.post(
			server.api`vehicles/${encodeURIComponent(vehicle.id)}/vehicletypeassignments`,
			JSON.stringify({
				parentId: vehicle.id,
				resourceType: id(type),
				priority: "1",
			}),
			{ headers }
		);

		return vehicleId;
	}

	return vehicle.id;
}

const vehicleTypeEntities = {
	SEW: {
		icon: "@IconDef&main=eOCS-13725-AmbulanceVehicle",
		name: "Sanitaetseinsatzfahrzeug",
	},
	NEF: {
		icon: "@IconDef&main=eOCS-13061-VehiclePatrol",
		name: "Notarzteinsatzfahrzeug",
	},
	NAW: {
		icon: "@IconDef&main=eOCS-13725-AmbulanceVehicle",
		name: "Notarztwagen",
	},
	NAH: {
		icon: "@IconDef&main=eOCS-13069-Helicopter",
		name: "Notarzthubschrauber",
	},
	BKTW: {
		icon: "@IconDef&main=eOCS-13070-GoatPatrol",
		name: "Behelfskrankentransportwagen",
	},
	ITH: {
		icon: "@IconDef&main=eOCS-13069-Helicopter",
		name: "Intensivtransporthunschrauber",
	},
	KAT: {
		icon: "@IconDef&main=eOCS-13070-GoatPatrol",
		name: "Fahrzeug des Katastrophenschutzes",
	},
};

function deleteEntities(array) {
	const endpoint = "vehicles";
	while (array.length > 0) {
		const currentVehicle = array.shift();
		http.del(server.api`${endpoint}/${currentVehicle}`, { headers });
		log.info(`Deleted entity (${currentVehicle}) from ${endpoint}`);
	}
}

function deleteAllVehicles(vehicleArray) {
	deleteEntities(vehicleArray);
}

function createIncident() {
	const state = {};
	const incidentCreatedResponse = eocs.incidents.new();
	isOk(incidentCreatedResponse);
	state.incident = incidentCreatedResponse.json();

	log.info(`Created incident with id ${state.incident.id} and number ${state.incident.number}`);
	return state;
}

function allocateVehicles(incident, vehicleArray, state) {
	vehicleArray.forEach((vehicleId) => {
		log.info(`Allocating vehicle with id ${vehicleId}`);
		performAllocation(incident, { id: vehicleId }, state);
	});
}

function performAllocation(incident, vehicle, state) {
	group("Perform Allocation", function () {
		state.startAllocationTime = Date.now();
		status200(eocs.incident(incident).allocatedresources.allocate(vehicle.id));
	});
}

function reserveVehicles(incident, vehicleArray, state) {
	group("Reserve Vehicle", function () {
		vehicleArray.forEach((vehicleId) => {
			reserveResource(incident.id, vehicleId, state);
		});
	});
}

function reserveResource(incidentId, resourceId, state) {
	const startTime = getRandomDate(new Date(), 0, 0, 1).toISOString(); // 5 dakika sonrasına rezervasyon
	const endTime = getRandomDate(new Date(), 0, 0, 10).toISOString(); // 10 dakika sonrasına rezervasyon

	const reserveResourceResponse = http.post(
		server.api`resourcereservations`,
		JSON.stringify([
			{
				id: null, // Yeni rezervasyon oluşturmak için null
				incidentId: incidentId,
				resourceId: resourceId,
				startTime: startTime,
				endTime: endTime,
				notificationTime: startTime,
				reservationTime: startTime,
			},
		]),
		{ headers }
	);

	status200(reserveResourceResponse);
	log.info(`Reserved vehicle with id ${resourceId} for incident ${incidentId}`);
}

function alertIncident(incident) {
	group("Alert incident", function () {
		log.debug(`Alerting incident ${incident.number}`);
		status200(eocs.incident(incident).alert());
	});
}

function completeIncident(incident) {
	group("Complete incident", function () {
		log.debug(`Completing incident ${incident.number}`);
		status200(eocs.incident(incident).complete());
	});
}

function finishIncident(incident) {
	group("Finish incident", function () {
		log.debug(`Finishing incident ${incident.number}`);
		status200(eocs.incident(incident).finish());
	});
}

function getRandomDate(date, days, hours, minutes) {
	return addMinutes(addHours(addDays(date, days), hours), minutes);
}




////////////////
servers.js
const servers = Object.assign(
	{},
	createServer("localhost", null, { scheme: "http", hostname: "localhost:8080" }),
	...[
		// performance test environment:
		"orion-main",
		...devServers.map((s) => s + "-main"),
		...teamServers,
	].map((clusterId) => createServer(clusterId))
);

////////////////
eocs.js
reserve_resource: {
					/**
					 * Creates new resource reservation.
					 * @param resourceReservationParams parameters to create a reservation of resource
					 * @returns {Response}
					 */
					reserve: (resourceReservationParams) => {
						return http.post(server.api`resourcereservations`, JSON.stringify(resourceReservationParams), { headers });
					},
				},


//////////////////
login.js
export function login() {
	const eocsconf = {
		username: env("user", "skirtactest"),
		password: env("password", "skirtactest"),
	};
