import { Abort, Mook } from "./mook.js"
import { MinkowskiParameter } from "../../lib-find-the-path/scripts/point.js";
import { FTPUtility } from "../../lib-find-the-path/scripts/utility.js";

let mookAI;

function getDistanceMetric ()
{
	return MinkowskiParameter[game.settings.settings.get ("mookAI.DistanceMetric").choices[game.settings.get ("mookAI", "DistanceMetric")]];
}

function log(message, type = "info") {
    const prefix = "mookAI | ";
    switch(type) {
        case "error":
            console.error(prefix + message);
            break;
        case "warn":
            console.warn(prefix + message);
            break;
        case "debug":
            console.debug(prefix + message);
            break;
        default:
            console.log(prefix + message);
    }
}

export function initAI ()
{
	mookAI = new MookAI ();

	game.settings.register ("mookAI", "DistanceMetric", {
		name: "Distance Metric",
		hint: "Distance on a grid can be measured multiple ways. Manhattan treats adjacent tiles as one unit away and diagonals as two. Chebyshev treats adjacent and diagonal tiles as one unit away. Euclidean (not recommended) treats tiles as though they existed in actual space: the center-to-center distance to diagonal tiles is sqrt(2) units.",
		scope: "world",
		config: true,
		default: "Manhattan",
		type: String,
		choices: ["Chebyshev", "Euclidean", "Manhattan"],
	});

	game.settings.register ("mookAI", "MoveAnimationDelay", {
		name: "Move Animation Delay",
		hint: "Controls the amount of time between mook token movements. Measured in miliseconds.",
		scope: "world",
		config: true,
		default: "400",
		type: Number,
	});

	game.settings.register ("mookAI", "RotationAnimationDelay", {
		name: "Rotation Animation Delay",
		hint: "Controls the max delay between mook rotation and their next movement. Varies by amount turned. Measured in miliseconds.",
		scope: "world",
		config: true,
		default: "400",
		type: Number,
	});

	game.settings.register ("mookAI", "MookType", {
		name: "Mook Type",
		hint: "Controls how mooks behave. Eager Beavers attack the closest token, using range only when there are no mele targets. Shias attack a random target in range. This feature is not fully developed. Consult documentation for specifics.",
		scope: "world",
		config: true,
		default: "EAGER_BEAVER",
		type: String,
		choices: ["EAGER_BEAVER", "SHIA"],
	});

	game.settings.register ("mookAI", "AutoEndTurn", {
		name: "Automatically End Turn",
		hint: "If enabled, mookAI will advance the combat tracker after a mook acts. Otherwise, it will not.",
		scope: "world",
		config: true,
		default: true,
		type: Boolean,
	});

	game.settings.register ("mookAI", "UseVision", {
		name: "Use Vision",
		hint: "If enabled, mooks will only attack enemies their tokens can see. If disabled, mooks have omniscient: they have full knowledge of the location of all tokens and the optimal path around/through all obstacles (such as mazes). Make sure that token vision is enabled and configured!",
		scope: "world",
		config: true,
		default: true,
		type: Boolean,
	});

	game.settings.register ("mookAI", "MookOmniscience", {
		name: "Mook Omniscience",
		hint: "If enabled, mooks will always find the most direct path to a target, even if the path itself is obscured or otherwise hard to navigate. If disabled, the path a mook takes can only consist of tiles the mook could see before the mook started moving. For example, an omniscient mook could perfectly navigate a maze if they had vision on a target from the initial position.",
		scope: "world",
		config: true,
		default: true,
		type: Boolean,
	});

	game.settings.register ("mookAI", "MookInitiative", {
		name: "Mook Initiative",
		hint: "Controls what mooks do when there is no target within range. They can do nothing, rotate in place, creep forward 1 tile at a time, or wander aimlessly (rotate + creep). If they find an enemy while \"exploring\" that is in range (after accounting for how far they have already moved), they will attack that target according to their configured behavior. In either case, they will pass their turn in combat afterward.",
		scope: "world",
		config: true,
		default: "WANDER",
		type: String,
		choices: ["DO_NOTHING", "ROTATE", "CREEP", "WANDER"],
	});

	game.settings.register ("mookAI", "DisableExploration", {
		name: "Mooks will not explore",
		hint: "If a mook cannot find a target, mookAI will stop without ending the turn.",
		scope: "world",
		config: true,
		default: false,
		type: Boolean
	});

	game.settings.register ("mookAI", "DisableRotation", {
		name: "Tokens will not rotate",
		hint: "If checked, mookAI will enable \"Lock Rotation\" in a token's settings before moving a mook. Afterward, it will return that setting to its initial value.",
		scope: "world",
		config: true,
		default: false,
		type: Boolean
	});

	game.settings.register ("mookAI", "ExploreAutomatically", {
		name: "Mooks explore automatically",
		hint: "If a mook cannot find a target, they will explore their environment without being directed.",
		scope: "world",
		config: true,
		default: true,
		type: Boolean
	});

	game.settings.register ("mookAI", "RotationCost", {
		name: "Rotation Cost",
		hint: "When exploring, mooks may end up rotating to search for heroes to die against. This setting controls how much movement, in tiles, each rotation costs. It can be set between 0.0 and 1.0 tiles unless the mook's initiative is set to \"Rotate.\" If the mook is configured to rotate, and the rotation cost is 0.0, then they will \"Do Nothing\" instead.",
		scope: "world",
		config: true,
		default: 0.2,
		type: Number,
	});

	game.settings.register ("mookAI", "UseMele", {
		name: "Mooks may use mele attacks",
		hint: "If enabled, mooks will check if they can make mele attacks. If disabled, they will not.",
		scope: "world",
		config: true,
		default: true,
		type: Boolean,
	});

	game.settings.register ("mookAI", "UseRanged", {
		name: "Mooks may use ranged attacks",
		hint: "If enabled, mooks will check if they can make ranged attacks. If disabled, they will not.",
		scope: "world",
		config: true,
		default: true,
		type: Boolean,
	});

	game.settings.register ("mookAI", "StandardMeleTileRange", {
		name: "Default mele weapon attack radius",
		hint: "Some mele weapons do not provide a max range. This setting, in units of tiles, is a fallback to allow mooks to attack in such instances. Setting this value to zero will prevent mooks from attacking with a ranged weapon that has no explicit range value. They will explore instead.",
		scope: "world",
		config: true,
		default: 1,
		type: Number,
	});

	game.settings.register ("mookAI", "StandardRangedTileRange", {
		name: "Default ranged weapon attack radius",
		hint: "Some ranged weapons do not provide a max range. This setting, in units of tiles, is a fallback to allow mooks to attack in such instances. Setting this value to zero will prevent mooks from attacking with a ranged weapon that has no explicit range value. They will explore instead.",
		scope: "world",
		config: true,
		default: 12,
		type: Number,
	});

	game.settings.register("mookAI", "WaitForMidiQoL", {
		name: "Wait for Midi-QoL",
		hint: "Wait for Midi-QoL to finish processing attacks before continuing (no effect if Midi-QoL is not installed)",
		scope: "world",
		config: true,
		type: Boolean,
		default: true
	});

	Hooks.on ("ready", () => {
		try
		{
			if (! mookAI.ready ())
				mookAI = {};
		}
		catch (e_)
		{
			console.log ("mookAI | Failed to initialize:")
			console.log (e_)
		}
	});
}

export class MookAI
{
	constructor ()
	{
		this._busy = true;
		this._combats = new Map ();
	}

	ready ()
	{
		if (! game.user.isGM)
		{
			// todo?: let heroes have mooks
			console.log ("mookAI | Heroes don't have mooks; they have friends!");
			return false;
		}

		Hooks.on ("updateToken", (token_, changes_, diff_, sceneID_) => {
			if (! diff_?.diff)
				return;
		
			this.updateTokens (changes_);
		});

		Hooks.on ("createCombatant", (combatant_, config_, id_) => {
			this.addCombatant (combatant_.combat.id, combatant_.tokenId);
		});
		Hooks.on ("deleteCombatant", (combatant_, config_, id_) => {
			this.deleteCombatant (id_, combatant_.tokenId);
		});
		Hooks.on ("createCombat", (combat_, config_, id_) => {
			this.combatStart (combat_, id_);
		});
		Hooks.on ("deleteCombat", (combat_, config_, id_) => {
			this.combatEnd (combat_, id_);
		});
		Hooks.on ("updateScene", (...args) => { this.handleSceneChange () });

		document.addEventListener('keyup', evt => {
			if (evt.key !== 'b' || ! evt.target.classList.contains ("game") || this.busy)
				return;

			game.combat.previousTurn ();
		});

		/*
		document.addEventListener('keyup', evt => {
			if (evt.key !== 't')
				return;

			console.time ("myTimer");
			const pm = game.FindThePath.Chebyshev.PathManager;

			(async () => {
				const points = await pm.pointsWithinRangeOfToken (canvas.tokens.placeables[0], 10);
				points.sort ((a, b) => {
					return 100 * (a.segment.point.x-b.segment.point.x)
						   + (a.segment.point.y - b.segment.point.y)
				});
				const segs = points.map (p => p.segment );
				const dists = points.map (p => p.dist );
				console.log (segs);
				console.log (dists);
				const ftpUtility = new FTPUtility ();
				ftpUtility.highlightSegments (segs);
			}) ();
			console.timeEnd ("myTimer");
		});
		*/

		document.addEventListener('keyup', evt => {
			if (evt.key !== 'n' || ! evt.target.classList.contains ("game") || this.busy)
				return;

			game.combat.nextTurn ();
		});

		if (game.modules.get("lib-find-the-path")?.active)
		{
			document.addEventListener('keyup', evt => {
				if (evt.key.toLowerCase () !== 'g' || ! evt.target.classList.contains ("game") || this.busy)
					return;
	
				if (evt.shiftKey)
					this.takeControlledTurns ();
				else if (evt.ctrlKey)
					this.takeNextTurn ();
				else if (evt.altKey)
					this.takeNextTurn ();
				else
					this.takeNextTurn ();
			});
		}
		else
		{
			const str = "mookAI | Missing module dependency: Library - Path Planning. Please check that it is installed and enabled. mookAI cannot automate without it."
			ui.notifications.notify (str, "error", { "permanent": true });
			console.log (str);
			return false;
		}

		this.metric = getDistanceMetric ();
		this._busy = false;
		return true;
	}

	handleSceneChange ()
	{
		this._combats = new Map ();
		this._busy = false;
	}
	
	addCombatant (combatId_, id_)
	{
		const mook = new Mook (canvas.tokens.get (id_), this.metric);
		this.combats.get (combatId_).set (id_, mook);
		console.log('adding mook: ', combatId_, id_);
		console.log('combats: ', this.combats)
		console.log('combat: ', this.combats.get (combatId_))
		console.log('mook: ', mook)
		return mook;
	}

	deleteCombatant (combat_, id_)
	{
		this.combats.get (combat_.id).delete (id_);
	}

	// Throws if there are no combats in the active scene
	async startCombats ()
	{
		game.combats.combats.forEach (c => { this.combatStart (c); });

		if (this._combats.size === 0)
		{
			ui.notifications.warn ("No combats in active scene.");
			throw "No combats in active scene";
		}

		await game.combat.activate ();
	}

	combatStart (combat_, id_)
	{
		log(`Starting combat: ${id_}`);
		
		if (combat_._source.scene !== game.scenes.active.id) {
			log("Combat not in active scene, skipping", "debug");
			return;
		}

		if (this.combats.get(combat_.id)) {
			log("Combat already active, skipping", "warn");
			return;
		}

		let newMooks = new Map();
		log("Adding combatants to combat");

		combat_.combatants.forEach(combatant => {
			const newToken = canvas.tokens.get(combatant.tokenId);
			if (!newToken) {
				log(`Failed to find token for combatant: ${combatant.tokenId}`, "warn");
				return;
			}
			log(`Adding mook for token: ${newToken.name || combatant.tokenId}`, "debug");
			newMooks.set(combatant.tokenId, new Mook(newToken, this.metric));
		});

		this._combats.set(combat_.id, newMooks);
		log(`Combat started with ${newMooks.size} mooks`);
	}

	combatEnd (combat_, id_)
	{
		if (! this.combats.has (id_))
		{
			log("Attempted to delete combat that does not exist.", "warn");
			return;
		}

		this.combats.delete (id_);
	}

	async endTurn ()
	{
		if (! this.autoEndTurn)
			return;

		return await game.combat.nextTurn ().catch (err => {
			ui.notifications.warn (err);
		});
	}

	getCombat ()
	{
		return this.combats.get (game.combat.id);
	}

	getMook (combat_, tokenId_)
	{
		if (! combat_)
			throw "Invalid combat"

		if (! combat_.has (tokenId_))
			return this.addCombatant (game.combat.id, tokenId_);

		return combat_.get (tokenId_);
	}

	async takeNextTurn ()
	{
		log("Taking next turn");
		this.applySettings();

		if (this._combats.size === 0) {
			log("No active combats, starting combats", "debug");
			await this.startCombats();
		}

		const currentTokenId = game.combat.current.tokenId;
		log(`Getting mook for token ID: ${currentTokenId}`, "debug");
		
		let success = await this.takeMookTurn(this.getMook(this.getCombat(), currentTokenId));
		log(`Turn completed with success: ${success}`);

		if (success) {
			log("Ending turn automatically", "debug");
			this.endTurn();
		}
	}

	// Takes a turn for all selected tokens regardless of initiative
	async takeControlledTurns ()
	{
		this.applySettings ();

		if (this._combats.size === 0)
			await this.startCombats ();

		for (let token of canvas.tokens.controlled)
			await this.takeMookTurn (this.getMook (this.getCombat (), token.id));
	}

	async takeMookTurn (mook_)
	{
		try
		{
			if (! mook_)
			{
				const errorMsg = `Failed to find mook (id: ${game.combat.current.tokenId}) in scene (id: ${game.scenes.active.id})`;
				log(errorMsg, "error");
				ui.notifications.warn("mookAI | Mook not found in scene. Please verify that the current scene is active.");
				throw new Error(errorMsg);
			}

			this._busy = true;
			log(`Starting turn for mook: ${mook_.token.name || 'unnamed'}`, "debug");

			await mook_.startTurn ();
			log("Sensing surroundings", "debug");
			await mook_.sense ();
			log("Planning turn", "debug");
			mook_.planTurn ();
			log("Executing actions", "debug");
			await mook_.act ();
			log("Ending turn", "debug");
			await mook_.endTurn ();

			this._busy = false;
			return true;
		}
		catch (e)
		{
			if (!(e instanceof Abort))
			{
				log("Encountered unrecoverable error:", "error");
				console.error(e);
			}
			else
			{
				log(e.message);
			}

			if (mook_)
			{
				log("Cleaning up after error", "debug");
				await mook_.cleanup ();
			}
			this._busy = false;
			return false;
		}
	}

	applySettings ()
	{
		this.changeMetric ();
	}

	changeMetric ()
	{
		const metric = getDistanceMetric ();

		if (this.metric === metric)
			return;
		
		this.metric = metric;
		this.combats.forEach ((mookMap, combatId) => {
			mookMap.forEach ((mook, mookId) => {
				this.addCombatant (combatId, mookId);
			});
		});
		
	}

	updateTokens (changes_)
	{
		this.combats.forEach (mooks => {
			mooks.forEach (m => { m.handleTokenUpdate (changes_); });
		});
	}

	get autoEndTurn () { return game.settings.get ("mookAI", "AutoEndTurn"); }

	// ;)
	get busy () { return this._busy; }

	get combats () { return this._combats; }
};
