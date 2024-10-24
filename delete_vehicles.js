adinda snm gecen vehicle lari siliyor ama 100 e yakin kadarini

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

import { check } from "k6";

export default function () {
	login();
	// Araçları arama URL'si
	const searchUrl = server.api`vehicles/_search`;

	// Araçları silme URL'si
	const deleteUrlBase = server.api`vehicles/`;

	// Search isteği için payload
	const searchPayload = JSON.stringify({
		filter: {
			"@type": "f0135b36-d355-4837-b0e6-595b16cd9a0c",
			filters: [
				{
					"@type": "f0135b36-d355-4837-b0e6-595b16cd9a0c",
					filters: [
						{
							"@type": "9cb91226-e54f-43bd-b120-4881f53b4eca",
							filters: [
								{
									"@type": "329d834e-9943-4b71-9be2-dad5598c83c0",
									propertyPath: "name",
									value: "snm",
									filterType: "CONTAINS",
								},
							],
						},
					],
				},
			],
		},
		ignoreVisibilityGroups: false,
		sort: "name:asc;",
		size: 100,
		startRow: 0,
	});

	// Araçları arama isteği
	const searchResponse = http.post(searchUrl, searchPayload, { headers });

	// Yanıtın statüsünü kontrol et
	check(searchResponse, {
		"Search request status is 200": (r) => r.status === 200,
	});

	// Yanıtın JSON formatında olup olmadığını kontrol et
	let vehicles;
	try {
		vehicles = searchResponse.json().elements;
	} catch (e) {
		console.error("Invalid JSON response. Response body:", searchResponse.body); // Yanıtı logluyoruz
		return;
	}

	// Eğer `elements` boş ise uyarı ver
	if (!vehicles || vehicles.length === 0) {
		console.warn("No vehicles found.");
		return;
	}

	// Araçların id'lerini bir array'a alıyoruz
	const vehicleIds = vehicles.map((vehicle) => vehicle.id);

	// Tüm araçları silmek için DELETE isteği gönderiyoruz
	vehicleIds.forEach((id) => {
		const deleteUrl = deleteUrlBase + id; // Silme URL'sine id ekliyoruz
		const deleteResponse = http.del(deleteUrl, null, { headers });

		// Her bir isteğin başarılı olup olmadığını kontrol ediyoruz
		check(deleteResponse, {
			[`Vehicle ${id} deleted`]: (r) => r.status === 200 || r.status === 204,
		});

		console.log(`Deleted vehicle with id: ${id}`);
	});
}
