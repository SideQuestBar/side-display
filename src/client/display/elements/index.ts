import type { Component } from "solid-js";
import type { ElementType } from "../../../shared/elements";
import { Banner, Menu, Pdf, Shape, Social, Wifi } from "./boards";
import { Gallery, Image, List, Qr, Rss, Slideshow, Sticker, Text, Ticker, Video, Web } from "./content";
import { Chart, JsonValue, Sports, Stocks, Transit, Uptime } from "./feeds";
import { HaCamera, HaEntities, HaEntity, HaGauge, HaGraph, HaMedia, HaTemplate, HaTodo } from "./ha";
import { HaAlerts, HaClimate, HaEnergy, HaPresence, HaStream } from "./ha-extra";
import { AirQuality, MapElement, Radar, Weather } from "./info";
import { Carousel, Columns, Divider, Grid, Spacer, SwitchElement } from "./layout";
import { MqttList, MqttValue } from "./mqtt";
import { Calendar, Clock, Countdown, DateElement, Hours } from "./time";
import { Birthdays, Progress, SunMoon, Timetable, WorldClocks } from "./time-extra";

/** The renderer of each element type. */
// biome-ignore lint/suspicious/noExplicitAny: each renderer narrows its own element type
export const renderers: Record<ElementType, Component<any>> = {
	text: Text,
	image: Image,
	gallery: Gallery,
	slideshow: Slideshow,
	video: Video,
	web: Web,
	qr: Qr,
	ticker: Ticker,
	list: List,
	sticker: Sticker,
	banner: Banner,
	menu: Menu,
	pdf: Pdf,
	social: Social,
	shape: Shape,
	wifi: Wifi,
	clock: Clock,
	date: DateElement,
	countdown: Countdown,
	calendar: Calendar,
	hours: Hours,
	"world-clocks": WorldClocks,
	timetable: Timetable,
	birthdays: Birthdays,
	progress: Progress,
	"sun-moon": SunMoon,
	weather: Weather,
	map: MapElement,
	"air-quality": AirQuality,
	radar: Radar,
	rss: Rss,
	transit: Transit,
	stocks: Stocks,
	sports: Sports,
	uptime: Uptime,
	json: JsonValue,
	chart: Chart,
	"ha-entity": HaEntity,
	"ha-entities": HaEntities,
	"ha-gauge": HaGauge,
	"ha-graph": HaGraph,
	"ha-camera": HaCamera,
	"ha-media": HaMedia,
	"ha-todo": HaTodo,
	"ha-template": HaTemplate,
	"ha-energy": HaEnergy,
	"ha-climate": HaClimate,
	"ha-presence": HaPresence,
	"ha-alerts": HaAlerts,
	"ha-stream": HaStream,
	mqtt: MqttValue,
	"mqtt-list": MqttList,
	columns: Columns,
	carousel: Carousel,
	grid: Grid,
	switch: SwitchElement,
	spacer: Spacer,
	divider: Divider,
};
