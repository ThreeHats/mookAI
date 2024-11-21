import { Behaviors, MookTypes, Target } from "./behaviors.js"
import { ActionType, MookModel } from "./mookModel.js";
import { PathManager } from "../../lib-find-the-path/scripts/pathManager.js";
import { PointFactory, SquareNeighborAngles, AngleTypes } from "../../lib-find-the-path/scripts/point.js";
import { FTPUtility } from "../../lib-find-the-path/scripts/utility.js";

export class Abort extends Error
{
	constructor (...params)
	{
		super (...params);
		if (Error.captureStackTrace) { Error.captureStackTrace (this, Abort) }
		this.name = "Abort"
	}
};

// Wrapper around FVTT token class
export class Mook
{
	constructor (token_, metric_)
	{
		this._token = token_;

		if (! this._token)
			throw new Abort(`Token with id ${token_.id} was not found`);

		// Used to create Point objects
		this._pointFactory = new PointFactory (metric_);
		// Manages the mook's attempts at path planning
		this._pathManager = new PathManager (metric_);

		this._disabledRotation = false;
		this._mookModel = MookModel.getMookModel (token_);
		this._start = this._pointFactory.segmentFromToken (token_);
		this._segment = this._start;
		this._targetedTokens = new Array ();
		this._visibleTargets = new Array ();
		// "time" represents how much a mook can do on their turn. Moving a tile costs 1 time unit by default.
		// todo: replace with a generalized cross-system resource manager (?!)
		this._time = this.mookModel.time;
		// Array of Actions
		this._plan = new Array ();

		this._collisionConfig = { checkCollision: true, whitelist: new Array (token_) };
		this._pathManagerConfig = { 
			collision: this._collisionConfig,
			priorityMeasure: null,
			constrainVision: true
		};
		this.utility= new FTPUtility ({
			token: token_,
			collisionConfig: this._collisionConfig
		});

		this.pcWarning = "<p style=\"color:red\">Warning: Token is owned by a player!</p>";
		this.debug = false;
	}

	async startTurn ()
	{
		console.log(`Starting turn for ${this.token.name || 'unnamed mook'}`);
		this.takeControl ();
		this.mookModel.startTurn ();

		this._start = this._pointFactory.segmentFromToken (this.token);
		this._segment = this._start;

		this._isExplorer = this.isExplorer;
		console.log(`Explorer status: ${this._isExplorer}`);

		this.time = this.mookModel.time;
		this._visibleTargets.splice (0);

		if (this.rotationDisabled)
			await this.lockRotation ();
	}

	async sense ()
	{
		this.pathManager.clearAll ();
		console.log("MookAI | Starting sense for", this.token.name);

		this._visibleTargets = game.combat.combatants.filter (combatant => {
			const id = combatant.tokenId;
			const token = canvas.tokens.get (id);

			console.log("MookAI | Checking potential target:", token.name, {
				disposition: token.document.disposition,
				mookDisposition: this.token.document.disposition,
				inCombat: token.inCombat,
				health: this.mookModel.getCurrentHealth (token)
			});

			// Even mooks won't target themselves on purpose
			if (id === this.token.id) return false;


			// Check disposition - target hostiles if friendly, friendlies if hostile
			const mookDisposition = this.token.document.disposition;
			const targetDisposition = token.document.disposition;
			
			// Skip secret tokens (-2)
			if (targetDisposition === -2) return false;
			// Skip neutral tokens (0) unless configured otherwise
			if (targetDisposition === 0) return false;
			// Target opposite disposition (hostile targets friendly, friendly targets hostile)
			if (mookDisposition * targetDisposition !== -1) return false;

			// todo: add "factions" to allow targeting of npcs
			// if (! this.isPC (token)) return false;
			// This shouldn't be possible
			if (! token.inCombat) return false;
			// Don't attack downed tokens
			if (this.mookModel.getCurrentHealth (token) <= 0) return false;
			// If the mook doesn't have vision, then it can see everyone. This choice avoids many problems.
			if (this.mookModel.hasVision && ! this.canSee (token.id)) return false;

			return true;
		}).map (c => { return canvas.tokens.get (c.tokenId); });

		console.log("MookAI | Found targets:", this._visibleTargets.map(t => t.name));

		// Todo: compute paths between tokens when one moves and then select paths here. 
		for (let t of this.visibleTargets)
			await this.pathManager.addToken (this.token, t, this.time, this.pathManagerConfig);
	}

	planTurn ()
	{
		console.log('MookAI | Planning turn for:', this.token.name);
		console.log('MookAI | Available targets:', this.visibleTargets.map(t => ({
			name: t.name,
			disposition: t.document.disposition,
			distance: canvas.grid.measureDistance(this.token, t)
		})));

		// Clear the previous plan
		this.plan.splice (0);

		if (this.visibleTargets.length === 0)
		{
			if (this.time < 1)
			{
				this.plan.push (this.mookModel.haltAction ());
				return;
			}

			this.plan.push ({ actionType: ActionType.EXPLORE });
			this.plan.push (this.mookModel.senseAction ());
			this.plan.push (this.mookModel.planAction ());
			return;
		}

		const targets = this.viableTargets;

		if (targets === null)
		{
			/*
			todo: move this into mook model.
			If mook can see a target but can't reach the target, then it should zoom if able (and if zooming will get it in range? what about multi-zoom)
			If mook cannot see target, but it is out of movement, it should zoom if able
			*/
			if (this.mookModel.canZoom)
			{
				const bonusTime = this.mookModel.zoom ();
				this.time += bonusTime;

				this.plan.push (this.mookModel.senseAction ());
				this.plan.push (this.mookModel.planAction ());
				return;
			}

			// If a mook can't find a target, they will explore to try to find one
			this.plan.push ({ actionType: ActionType.EXPLORE });
			this.plan.push (this.mookModel.senseAction ());
			this.plan.push (this.mookModel.planAction ());
			return;
		}

		// Of type Target
		const target = Behaviors.chooseTarget(this, targets);

		this.plan.push ({
			actionType: ActionType.TARGET,
			data: { "target": target.token },
		});

		const path = this.pathManager.path (this.token.id, target.id);

		if (path.valid)
			this.plan.push ({
				actionType: ActionType.TRAVERSE,
				cost: path.within (target.range).length - 1,
				data: { "path": path, "dist": target.range }
			});
		else
			this.plan.push ({
				actionType: ActionType.TRAVERSE,
				cost: 0,
				data: { "path": null, "dist": target.range }
			});

		console.log('MookAI | Movement planning:', {
			pathLength: path.valid ? path.within(target.range).length - 1 : 0,
			currentTime: this.time,
			baseMovement: this.mookModel.baseMovement,
			availableMovement: this.mookModel.availableMovement
		});
		
		this.plan.push (this.mookModel.faceAction (target.token));

		const attackAction = target.attackAction;
		const multiattackRules = this.mookModel._parseMultiattack();
		const weapon = attackAction.data.weapon;
		
		// Set attack count based on weapon type and multiattack rules
		if (multiattackRules) {
			if (weapon.system.properties.rwak && multiattackRules.ranged) {
				attackAction.data.attackCount = multiattackRules.ranged;
			} else if (weapon.system.properties.mwak && multiattackRules.melee) {
				attackAction.data.attackCount = multiattackRules.melee;
			}
		}

		console.log('MookAI | Planning attack with:', {
			weapon: weapon.name,
			properties: weapon.system.properties,
			multiattack: multiattackRules,
			attackCount: attackAction.data.attackCount
		});

		this.plan.push(attackAction);

		this.plan.push (this.mookModel.haltAction ());
	}

	async act ()
	{
		if (this.debug) console.log ("Acting");

		// todo: Setting to disable
		await this.centerCamera ();

		// todo: true timer
		let tries = 100;
		while (this.time >= 0 && --tries)
		{
			if (this.debug) console.log ("Try #%f", 100 - tries);

			if (this.plan.length === 0)
			{
				console.log ("mookAI | Planning failure: empty plan.");
				return;
			}

			if (this.plan.reduce (a => a?.cost) > this.time)
			{
				if (this.mookModel.canZoom)
				{
					this.time += this.mookModel.zoom ();
					continue;
				}

				console.log ("mookAI | Planning failure: too ambitious.");
				return;
			}

			let action = this.plan.splice (0, 1)[0];

			if (this.debug) console.log (action);

			switch (action.actionType)
			{
			case (ActionType.HALT):
				if (this.debug) console.log ("Halting");
				this.cleanup ();
				return;
			case (ActionType.SENSE):
				if (this.debug) console.log ("Sensing");
				await this.sense ();
				break;
			case (ActionType.PLAN):
				if (this.debug) console.log ("Planning");
				this.planTurn ();
				break;
			case (ActionType.ROTATE):
				if (this.debug) console.log ("Rotating");
				await this.rotate (action.data);
				break;
			case (ActionType.FACE):
				if (this.debug) console.log ("Rotating to face target");
				await this.rotate (this.degreesToTarget (action.data));
				break;
			case (ActionType.MOVE):
				if (this.debug)
					console.log ("Moving from (%f, %f) to (%f, %f)",
								this.point.x, this.point.y, action.data.x, action.data.y);
				await this.move (action.data);
				break;
			case (ActionType.EXPLORE):
				if (this.isExploreDisabled)
					this.handleFailure (new Abort ("Not taking turn. Mook found no targets and exploration is disabled."));

				if (this.debug) console.log ("Exploring");

				if (! this._isExplorer)
				{
					let dialogContent = "<p>The mook could not find a target. This could be because they don't have vision on a PC or because they are outside of weapon range.</p><p>The mook can explore their environment and try to find a target. Otherwise, mookAI will return control to the user.</p>";

					if (this.token.actor.hasPlayerOwner)
						dialogContent = this.pcWarning + dialogContent;

					let dialogPromise = new Promise ((resolve, reject) => {
						const dialog = new Dialog ({
							title: "Mook wants to explore!",
							content: dialogContent,
							buttons: {
								approve: {
									label: game.i18n.localize ("Explore"),
									callback: () => { resolve (); }
								},
								reject: {
									label: game.i18n.localize ("Assume Direct Control"),
									callback: () => { reject (); }
								}
							},
							default: "approve",
							close: reject
						});
	
						dialog.render (true);
						dialog.position.top = 120;
						dialog.position.left = 120;
					});

					try {
						await dialogPromise;
					}
					catch (error)
					{
						this.handleFailure (new Abort ("Mook not exploring; out of actions."));
					}

					this._isExplorer = true;
				}

				const exploreActions = this.mookModel.exploreActions ();
				for (let i = 0; i < exploreActions.length; ++i)
					this.plan.splice (i, 0, exploreActions[i]);
				break;
			case (ActionType.TARGET):
				if (this.debug) console.log ("Targeting");
				this.target (action.data.target);
				break;
			case (ActionType.ATTACK):
				if (this.debug) console.log("Attacking!");
				
				const midiActive = game.modules.get("midi-qol")?.active;
				const waitForMidi = game.settings.get("mookAI", "WaitForMidiQoL") ?? true;

				try {
					if (midiActive && waitForMidi) {
						// Create a promise that resolves when all attacks and their rolls are complete
						await new Promise(async (resolve) => {
							let attacksInProgress = action.data.attackCount || 1;
							
							console.log(`MookAI | Expecting ${attacksInProgress} attacks`);
							
							const completeHook = Hooks.on('midi-qol.RollComplete', () => {
								attacksInProgress--;
								console.log(`MookAI | Attacks remaining: ${attacksInProgress}`);
								if (attacksInProgress === 0) {
									Hooks.off('midi-qol.RollComplete', completeHook);
									resolve();
								}
							});

							await this.mookModel.attack(action);
							
							// If no attacks were actually made, resolve immediately
							if (attacksInProgress === 0) {
								Hooks.off('midi-qol.RollComplete', completeHook);
									resolve();
							}
						});
					} else {
						// Original behavior without waiting for midi-qol
						if (!this.mookModel.canAttack) {
							throw new Error("mookAI | Planning failure: mook took too many actions.");
						}
						while (this.mookModel.canAttack) {
							await this.mookModel.attack(action);
						}
					}
				} catch (error) {
					this.handleFailure(error.message);
					return;
				}
				break;
			case (ActionType.STEP):
				if (this.debug) console.log ("Stepping");
				if (! await this.step ())
					this.handleFailure (new Error ("Failed to take step"));
				break;
			case (ActionType.TRAVERSE):
				if (this.debug) console.log("Traversing");

				const plannedAction = this._plan.find(a => a.actionType === ActionType.ATTACK);
				const weapon = plannedAction?.data?.weapon;
				const allActions = this.token.actor.items.filter(i => 
					i.type === "weapon" || (i.type === "feat" && i.name.toLowerCase().includes("multiattack"))
				);

				// Calculate movement details
				let movableSegments = [];
				let requiresDash = false;
				if (action.cost > 0 && action.data.path) {
					const path = action.data.path;
					const segments = path.within(action.data.dist);
					const maxMovement = this.mookModel.availableMovement;
					movableSegments = segments.slice(0, Math.floor(maxMovement) + 1);
					
					if (movableSegments.length > 0) {
						this.utility.path = action.data.path;
						this.utility.highlightPoints(action.data.path.path
							.slice(0, Math.floor(maxMovement) + 1)
							.map(s => s.origin));
					}

					const isMeleeAttack = weapon?.system?.properties?.mwak || 
										 (weapon?.system?.actionType === 'mwak');
					requiresDash = isMeleeAttack && action.cost > this.mookModel.baseTime;

					console.log('MookAI | Movement evaluation:', {
						isMeleeAttack,
						movementCost: action.cost,
						baseTime: this.mookModel.baseTime,
						canZoom: this.mookModel.canZoom,
						requiresDash,
						movableDistance: movableSegments.length
					});

					// Before creating dialogContent, prepare the descriptions
					const enrichedDescriptions = await Promise.all(allActions.map(item => 
						TextEditor.enrichHTML(item.system?.description?.value || '')
					));

					let dialogContent = `
						<div class="mook-action-dialog">
							<h3>Movement Options</h3>
							<div class="movement-options">
								<label>
									<input type="radio" name="movement" value="move" ${action.data.path ? 'checked' : ''}>
									 Move ${movableSegments.length - 1} spaces
									 ${requiresDash ? ' (Requires Dash)' : ''}
								</label>
								<label>
									<input type="radio" name="movement" value="stay" ${!action.data.path ? 'checked' : ''}>
									Stay in current position
								</label>
							</div>
							
							<h3>Available Actions</h3>
							<div class="action-list">
								${allActions.map((item, index) => {
									// Calculate number of attacks
									let maxAttacks = 1;
									const itemName = item.name.toLowerCase();
									if (this.mookModel.multiattackRules) {
										const attackType = Object.entries(this.mookModel.multiattackRules).find(([type, _]) => {
											const normalizedType = type.toLowerCase().replace(/\s+/g, '');
											return itemName.includes(normalizedType) || 
												   (type.includes('melee') && item.system?.actionType === 'mwak') ||
												   (type.includes('ranged') && item.system?.actionType === 'rwak');
										});
										if (attackType) maxAttacks = attackType[1];
									}
									
									return `
										<div class="action-card ${item.id === weapon?.id ? 'selected' : ''}" 
											 data-item-id="${item.id}">
											<div class="attack-controls">
												<select name="attack-count-${item.id}" class="attack-count"
														${requiresDash ? 'disabled' : ''}>
													${Array.from({length: maxAttacks}, (_, i) => i + 1).map(num => 
														`<option value="${num}" ${num === maxAttacks ? 'selected' : ''}>${num}×</option>`
													).join('')}
												</select>
											</div>
											<img src="${item.img}" width="36" height="36"/>
											<div class="action-details">
												<h4>${item.name}</h4>
												<p>${enrichedDescriptions[index]}</p>
												<div class="action-cost">
													${item.system?.activation?.cost || 1}
													${item.system?.activation?.type || 'action'}
													${requiresDash ? '<span class="dash-warning">(Requires action for Dash)</span>' : ''}
												</div>
											</div>
										</div>
									`;
								}).join('')}
							</div>
							
							${this.mookModel.multiattackRules ? `
							<h3>Multiattack Details</h3>
							<div class="multiattack-info">
								${Object.entries(this.mookModel.multiattackRules)
									.map(([type, count]) => `<p>${count}× ${type}</p>`)
									.join('')}
							</div>
							` : ''}
						</div>
					`;

					let dialogResult = await new Promise((resolve, reject) => {
						new Dialog({
							title: "Confirm Mook Actions",
							content: dialogContent,
							buttons: {
								confirm: {
									label: "Confirm",
									callback: (html) => {
										const selectedCard = html.find('.action-card.selected');
										const movement = html.find('input[name="movement"]:checked').val();
										
										if (movement === 'move' && !selectedCard.length && !requiresDash) {
											ui.notifications.warn("Please select an action or stay in place");
											return;
										}
										
										resolve({
											movement,
											selectedActionId: selectedCard.data('item-id'),
											attackCount: parseInt(selectedCard.find('select[name^="attack-count"]').val() || 0),
											requiresDash
										});
									}
								},
								cancel: {
									label: "Cancel",
									callback: () => reject(new Abort("Action cancelled by user"))
								}
							},
							default: "confirm",
							render: (html) => {
								const updateActionCards = (isDashing) => {
									const cards = html.find('.action-card');
									if (isDashing) {
										cards.removeClass('selected');
										html.find('.attack-count').prop('disabled', true);
									} else {
										html.find('.attack-count').prop('disabled', false);
										if (weapon) {
											html.find(`.action-card[data-item-id="${weapon.id}"]`).addClass('selected');
										}
									}
								};

								html.find('.action-card').click(function() {
									const movementInput = html.find('input[name="movement"]:checked');
									const isDashing = movementInput.val() === 'move' && requiresDash;
									
									if (isDashing) {
										ui.notifications.warn("Cannot select actions while dashing");
										return;
									}
									
									html.find('.action-card').removeClass('selected');
									$(this).addClass('selected');
								});

								html.find('input[name="movement"]').change(function() {
									const isDashing = $(this).val() === 'move' && requiresDash;
									updateActionCards(isDashing);
								});

								// Initial state
								const initialIsDashing = html.find('input[name="movement"]:checked').val() === 'move' && requiresDash;
								updateActionCards(initialIsDashing);
							},
							close: () => reject(new Abort("Dialog closed"))
						}).render(true);
					});

					// Handle movement
					if (dialogResult.movement === 'move' && action.cost > 0 && action.data.path) {
						const path = action.data.path;
						const segments = path.within(action.data.dist);
						const maxMovement = this.mookModel.availableMovement;
						
						// Only move up to our maximum available movement
						const movableSegments = segments.slice(0, Math.floor(maxMovement) + 1);
						
						console.log('MookAI | Movement calculation:', {
							totalSegments: segments.length,
							maxMovement,
							movableSegments: movableSegments.length
						});
						
						for (let i = 1; i < movableSegments.length; i++) {
							if (!await this.move(movableSegments[i])) {
								throw new Error("Failed to move to segment");
							}
						}
					}

					// Update attack plans based on dialog choices
					if (plannedAction) {
						if (dialogResult.movement === 'move' && dialogResult.requiresDash) {
							console.log("Removing attack action due to dash");
							const attackIndex = this._plan.findIndex(a => a.actionType === ActionType.ATTACK);
							if (attackIndex !== -1) {
								this._plan.splice(attackIndex, 1);
							}
						} else if (dialogResult.selectedActionId) {
							console.log(`Updating attack with weapon ID: ${dialogResult.selectedActionId}`);
							if (dialogResult.selectedActionId !== weapon?.id) {
								const newWeapon = this.token.actor.items.get(dialogResult.selectedActionId);
								plannedAction.data.weapon = newWeapon;
							}
							plannedAction.data.attackCount = dialogResult.attackCount;
						}
					}
				}
				break;
			}

			this.time -= action.cost ? action.cost : 0;
		}

		let str = "mookAI | Unknown failure";

		if (tries <= 0)
			str = "mookAI | Planning failure: forced exit after too many loops.";
		if (this.time <= -1)
			str = "mookAI | Planning failure: mook took too many actions.";

		this.handleFailure (str);
	}

	inCombat () { return this.token.inCombat; }
	isPC (token_ = this.token) { return token_.actor.hasPlayerOwner; }

	handleTokenUpdate (changes_)
	{
		if (changes_._id !== this.token.id)
			return;

		this.segment.update (changes_);
	}

	async cleanup ()
	{
		// todo: Undo all actions
		console.log(`Cleaning up mook: ${this.token.name || 'unnamed'}`);
		this.utility.clearHighlights ();
		this.clearTargets ();
		await this.endTurn ();
	}

	// Mooks don't have the emotional intelligence to handle failure :(
	// todo: teach mooks how to love themselves
	handleFailure (error_)
	{
		console.log(`Mook failure: ${error_.message}`);
		throw error_;
	}

	canSee (id_)
	{
		// I have no idea how this works, but it seems to anyway
		return canvas.tokens.children[0].children.some (e =>
			{ return e.id === id_ && e.isVisible; });
	}

	async centerCamera ()
	{
		const p = this._pointFactory.centerFromToken (this.token);
		await canvas.animatePan ({ x: p.px, y: p.py });
	}

	// Expects degrees
	async rotate (dTheta_)
	{
		if (dTheta_ === null || dTheta_ === undefined || dTheta_ === NaN)
		{
			console.error ("mookAI | Attempted invalid rotation");
			return;
		}

		await this.tokenDoc.update ({ rotation: (this.rotation + dTheta_) % 360 });
		await new Promise (resolve => setTimeout (resolve, this.rotationDelay));
	}

	get viableTargets ()
	{
		let meleTargets = [];
		let rangedTargets = [];

		if (this.mookModel.hasMele)
			meleTargets = this.visibleTargets.filter (e => {
				return this.isTargetReachable (e, this.mookModel.meleRange)
			});

		if (this.mookModel.hasRanged)
			rangedTargets = this.visibleTargets.filter (e => {
				return this.isTargetReachable (e, this.mookModel.rangedRange)
			});

		if (meleTargets.length === 0 && rangedTargets.length === 0)
			return null;

		return { "mele": meleTargets, "ranged": rangedTargets };
	}

	/**
	 * @param {Token} target_
	**/
	degreesToTarget (target_)
	{
		const p1 = this._pointFactory.centerFromToken (this.token);
		const p2 = this._pointFactory.centerFromToken (target_);
		return p1.radialDistToPoint (p2, this.rotation, AngleTypes.DEG);
	}

	async move (segment_)
	{
		if (! this.utility.isTraversable (this.segment, segment_))
			return false;

		let error = false;

		await this.rotate (this.segment.radialDistToSegment (segment_, this.token.rotation, AngleTypes.DEG));
		await this.tokenDoc.update ({ x: segment_.point.px, y: segment_.point.py }).catch (err => {
			ui.notifications.warn (err);
			error = true;
		});

		if (error) return false;

		this._segment = segment_;

		await this.centerCamera ();
		await new Promise (resolve => setTimeout (resolve, this.moveDelay));

		return true;
	}

	async step ()
	{
		const angles = this.neighborAngles.sort ((a, b) =>
		{
			return Math.min (a, 360 - a) - Math.min (b, 360 - b);
		});
		for (let angle of angles)
		{
			let success = await this.move (this.segment.neighbor (angle, this.rotation));
			if (success) return true;
		}

		return false;
	}

	async endTurn ()
	{
		if (this.rotationDisabled)
			await this.unlockRotation ();

		this.releaseControl ();
	}

	isTargetReachable (target_, attackRange_)
	{
		return this.pathManager.path (this.token.id, target_.id).terminalDistanceToDest <= attackRange_;
	}

	async lockRotation ()
	{
		if (this.tokenLocked === true)
			return;

		await this.tokenDoc.update ({ lockRotation: true });
		this._disabledRotation = true;
	}

	async unlockRotation ()
	{
		if (! this._disabledRotation)
			return;

		await this.tokenDoc.update ({ lockRotation: false });
		this._disabledRotation = false;
	}

	releaseControl () { this.token.release ({}); }
	takeControl () { this.token.control ({}); }

	clearTargets ()
	{
		for (const t of this._targetedTokens)
			t.setTarget (false, { releaseOthers: true, groupSelection: false });

		this._targetedTokens = new Array ();
	}

	target (token_)
	{
		if (!token_) return;
		
		// Clear existing targets
		game.user.targets.clear();
		// Add new target
		token_.setTarget(true, { user: game.user, releaseOthers: true });
	}

	get isExploreDisabled ()
	{
		const ret = game.settings.get ("mookAI", "DisableExploration");
		return (typeof ret === "boolean") ? ret : false;
	}

	get isExplorer ()
	{
		const ret = game.settings.get ("mookAI", "ExploreAutomatically");
		return (typeof ret === "boolean") ? ret : false;
	}

	get neighborAngles () { return Object.values (SquareNeighborAngles); }

	get mookModel () { return this._mookModel; } 

	get moveDelay ()
	{
		const ret = game.settings.get ("mookAI", "MoveAnimationDelay");
		if (ret < 0) return 0;
		if (ret > 1000) return 1000;
		return ret;
	}

	get pathManager () { return this._pathManager; } 
	get pathManagerConfig ()
	{
		this._pathManagerConfig.constrainVision = ! game.settings.get ("mookAI", "MookOmniscience");
		return this._pathManagerConfig;
	} 

	get plan () { return this._plan; }

	get point () { return this._segment.point; }

	get rotation () { return this.token.rotation; }

	get rotationDelay ()
	{
		const ret = game.settings.get ("mookAI", "RotationAnimationDelay");
		if (ret < 0) return 0;
		if (ret > 1000) return 1000;
		return ret;
	}

	get segment () { return this._segment; }

	get time () { return this._time; }
	set time (speed_) { this._time = speed_; }

	get token () { return this._token; }
	get tokenDoc () { return game.scenes.active.tokens.get(this._token.id) }

	//where is this located and used?
	get tokenLocked () { return this.token.lockRotation; }

	get visibleTargets () { return this._visibleTargets; }
}

