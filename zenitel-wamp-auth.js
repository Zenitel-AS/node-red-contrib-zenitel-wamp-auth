module.exports = function (RED) {
    "use strict";
    var events = require("events");
    var autobahn = require("autobahn");
    var settings = RED.settings;
    var cryptojs = require("crypto-js");

//Must be active when running from Linux
//	var fetch = require("node-fetch");
	
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"

	const tls = require("tls");

	tls.DEFAULT_MIN_VERSION = "TLSv1.2";
	tls.DEFAULT_MAX_VERSION = "TLSv1.3";

    const DEFAULT_WAMP_PORT = "8086";
    function wrapWampCallPayload(payload) {
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
            const kwargs = Object.assign({}, payload);
            const args0 = Object.assign({}, payload);
            return { args: [args0], kwargs: kwargs };
        }
        if (Array.isArray(payload)) {
            return { args: payload.slice(), kwargs: {} };
        }
        if (payload === undefined) {
            return { args: [], kwargs: {} };
        }
        return { args: [payload], kwargs: {} };
    }

    function ensurePayloadObject(msg) {
        if (typeof msg.payload !== "object" || msg.payload === null) {
            msg.payload = {};
        }
        return msg.payload;
    }

    function assignConfigValue(target, value, aliases) {
        if (value === undefined || value === null || value === "") {
            return;
        }
        let normalized = value;
        if (typeof normalized === "number") {
            normalized = String(normalized);
        }
        aliases.forEach(function (alias) {
            if (target[alias] === undefined) {
                target[alias] = normalized;
            }
        });
    }

    function syncAliases(target, aliases) {
        let chosen;
        for (let i = 0; i < aliases.length; i++) {
            const val = target[aliases[i]];
            if (val !== undefined && val !== null && val !== "") {
                chosen = val;
                break;
            }
        }
        if (chosen !== undefined) {
            let normalized = chosen;
            if (typeof normalized === "number") {
                normalized = String(normalized);
            }
            aliases.forEach(function (alias) {
                target[alias] = normalized;
            });
        }
    }

    function findMissingAliases(target, aliasGroups) {
        const missing = [];
        aliasGroups.forEach(function (group) {
            const hasValue = group.some(function (alias) {
                const val = target[alias];
                return val !== undefined && val !== null && val !== "";
            });
            if (!hasValue) {
                missing.push(group[0]);
            }
        });
        return missing;
    }

    function handleWampCallResult(result, node, msg, send, done) {
        if (result && typeof result.then === "function") {
            result.then(function (resp) {
                RED.log.debug("call result: " + JSON.stringify(resp));
                msg.payload = resp;
                send(msg);
                if (done) done();
            }).catch(function (err) {
                const em = (err && (err.error || err.message)) ? (err.error || err.message) : String(err);
                node.status({ fill: "red", shape: "dot", text: em });
                node.error(em, msg);
                msg.error = em;
                send(msg);
                if (done) done(err);
            });
        } else {
            msg.payload = result;
            send(msg);
            if (done) done();
        }
    }

    function reportMissing(node, msg, send, done, missing) {
        const text = "Missing required fields: " + missing.join(", ");
        node.status({ fill: "red", shape: "dot", text: text });
        node.error(text, msg);
        msg.error = text;
        send(msg);
        if (done) done(text);
    }

    async function restFetchGpioList(kind, dirno, clientNode) {
        // kind: "gpis" or "gpos"
        const address = clientNode.address || "";
        const encrypt = address.includes("wss");
        const addrParts = address.split(":"); // e.g., ["wss", "//10.0.0.5", "8086"]
        const ip = (addrParts[1] || "").replace("//", "");
        const base = encrypt ? "https://" + ip + ":443" : "http://" + ip + ":80";
        const path = "/api/devices/device;dirno=" + encodeURIComponent(dirno) + "/" + kind;

        const token = await GetToken(clientNode.authId, clientNode.password, address);

        const resp = await fetch(base + path, {
            method: "GET",
            headers: {
                "accept": "application/json",
                "Authorization": "Bearer " + token
            }
        });

        let body;
        try {
            body = await resp.json();
        } catch (e) {
            body = null;
        }

        if (!resp.ok) {
            const err = new Error("REST " + kind + " fetch failed (" + resp.status + ")");
            err.status = resp.status;
            err.body = body;
            throw err;
        }

        return body;
    }

//-------------------------------------------------------------------------------------------------------------------

  function WampClientNode(config) {
    RED.nodes.createNode(this, config);

    // Port is fixed server-side; only IP is configurable.
    const ip = config.ip || "";
    const port = DEFAULT_WAMP_PORT;
    this.address = "wss://" + ip + ":" + port;

    this.realm = "zenitel";
    this.authId = config.authId;
    this.password = config.password;
    this.port = port;

    this.wampClient = function () {
        return wampClientPool.get(this.address, this.realm, this.authId, this.password);
    };

    this.on = function (a, b) {
        this.wampClient().on(a, b);
    };

    this.close = function (done) {
        wampClientPool.close(this.address, this.realm, this.authId, this.password, done);
    };
}

RED.nodes.registerType("wamp-client", WampClientNode);




//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Event Nodes below	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Event|8| Node for generic subscriptions	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->

    function WampClientInNode(config) {
        RED.nodes.createNode(this, config);
        this.role = "subscriber";
        this.router = config.router;
        this.topic = config.topic;
		
//EM		
		RED.log.info("WampClientInNode(subscriber): role: " + this.role + ". router: " + this.router + ". topic: " + this.topic);				


        this.clientNode = RED.nodes.getNode(this.router);

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            switch (this.role) {
                case "subscriber":
				
//EM				
		RED.log.info("WampClientInNode(subscriber): Call to node.wampClient.subscribe().");				
                    if (!node.topic) {
                        RED.log.warn("Zenitel WAMP In subscriber missing topic configuration.");
                        node.status({fill:"red",shape:"dot",text:"no topic configured"});
                        break;
                    }

                    node.wampClient.subscribe(node.topic,
                        function (args, kwargs) {
                            var msg = {topic: node.topic, payload: {args: args, kwargs: kwargs}};
                            node.send(msg);
                        });
                    break;


                case "calleeReceiver":
                    node.wampClient.registerProcedure(this.topic, function (args, kwargs) {
                        RED.log.debug("procedure: " + args +", " +kwargs);
                        var d = autobahn.when.defer(); // create a deferred
                        var msg = {procedure: this.topic, payload: {args: args, kwargs: kwargs}, _d: d};
                        node.send(msg);
                        return d.promise;
                    });
                    break;


                default:
                    RED.log.error("the role ["+this.role+"] is not recognized.");
                    break;
            }
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("Zenitel WAMP In", WampClientInNode);

//-------------------------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Event|1| Node for directly reading General Purpose Inputs on a Zenitel intercom device	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
    function ZenitelGPINode(config) {
        RED.nodes.createNode(this, config);
        this.role = "subscriber";
        this.router = config.router;
        this.topic = "com.zenitel.device.gpi";


//EM		
		RED.log.info("WampClientInNode(subscriber): role: " + this.role + ". router: " + this.router + ". topic: " + this.topic);



        this.clientNode = RED.nodes.getNode(this.router);

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            switch (this.role) {
                case "subscriber":
				
//EM				
		RED.log.info("WampClientInNode(subscriber): Call to node.wampClient.subscribe().");				
				
                    node.wampClient.subscribe(this.topic,
                        function (args, kwargs)
                        {
                            var msg = {topic: node.topic,  payload: {args: args, kwargs: kwargs}};
                            var eventData = (Array.isArray(args) && args.length > 0) ? args[0] : null;

                            if (!eventData) {
                                node.send(msg);
                                return;
                            }

                            var eventDirno = String(eventData.dirno || "");
                            var eventId = String(eventData.id || "");
                            var eventGpis = String(eventData.gpis || "");
                            var eventState = String(eventData.state || "");

                            RED.log.info("Zenitel GPI node received message: " + JSON.stringify(msg) +
                                " filtering for: dirno: " + config.dirno + " input: " + config.GPinput +
                                " state: " + config.GPstate);

                            var dirFilter = config.dirno || "";
                            var dirMatches = eventDirno.includes(dirFilter);

                            var inputFilter = config.GPinput || "";
                            var normalizedInputFilters = [];
                            if (inputFilter) {
                                normalizedInputFilters.push(inputFilter);
                                if (inputFilter.indexOf("gpio") === 0) {
                                    normalizedInputFilters.push("gpi" + inputFilter.slice(4));
                                } else if (inputFilter.indexOf("gpi") === 0) {
                                    normalizedInputFilters.push("gpio" + inputFilter.slice(3));
                                }
                            }
                            var inputMatches = !inputFilter || normalizedInputFilters.some(function (filterValue) {
                                return eventId.includes(filterValue) || eventGpis.includes(filterValue);
                            });

                            var stateMatches = eventState.includes(config.GPstate || "");

                            if (dirMatches && inputMatches && stateMatches) {
                                node.send(msg);
                            }
                        });
                    break;


                case "calleeReceiver":
                    node.wampClient.registerProcedure(this.topic, function (args, kwargs) {
                        RED.log.debug("procedure: " + args +", " +kwargs);
                        var d = autobahn.when.defer(); // create a deferred
                        var msg = {procedure: this.topic, payload: {args: args, kwargs: kwargs}, _d: d};
                        node.send(msg);
                        return d.promise;
                    });
                    break;


                default:
                    RED.log.error("the role ["+this.role+"] is not recognized.");
                    break;
            }
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("Zenitel GPI Event", ZenitelGPINode);

//-------------------------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Event|2| Node for directly reading General Purpose Outputs on a Zenitel intercom device	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
    function ZenitelGPONode(config) {
        RED.nodes.createNode(this, config);
        this.role = "subscriber";
        this.router = config.router;
        this.topic = "com.zenitel.device.gpo";


//EM		
		RED.log.info("WampClientInNode(subscriber): role: " + this.role + ". router: " + this.router + ". topic: " + this.topic);



        this.clientNode = RED.nodes.getNode(this.router);

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            switch (this.role) {
                case "subscriber":
				
//EM				
		RED.log.info("WampClientInNode(subscriber): Call to node.wampClient.subscribe().");				
				
                    node.wampClient.subscribe(this.topic,
     					function (args, kwargs)
     					{
							var msg = {topic: this.topic,  payload: {args: args, kwargs: kwargs}
						};
						RED.log.info("Zenitel GPO node received message: " + JSON.stringify(msg) + " filtering for: dirno: " + config.dirno + " output: " + config.GPoutput + " state: " + config.GPstate);
						var ContainsDirno = msg.payload.args[0].dirno.includes(config.dirno);
						var ContainsGPoutput = msg.payload.args[0].id.includes(config.GPoutput);
						var ContainsGPstate = msg.payload.args[0].operation.includes(config.GPstate);
											
						if(ContainsDirno && ContainsGPoutput  && ContainsGPstate){
                        node.send(msg);
						}
                    });
                    break;


                case "calleeReceiver":
                    node.wampClient.registerProcedure(this.topic, function (args, kwargs) {
                        RED.log.debug("procedure: " + args +", " +kwargs);
                        var d = autobahn.when.defer(); // create a deferred
                        var msg = {procedure: this.topic, payload: {args: args, kwargs: kwargs}, _d: d};
                        node.send(msg);
                        return d.promise;
                    });
                    break;


                default:
                    RED.log.error("the role ["+this.role+"] is not recognized.");
                    break;
            }
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("Zenitel GPO Event", ZenitelGPONode);

//-------------------------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Event|3| Node for directly reading Door open events on a Zenitel intercom device	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
    function ZenitelDoorOpen(config) {
        RED.nodes.createNode(this, config);
        this.role = "subscriber";
        this.router = config.router;
        this.topic = "com.zenitel.system.open_door";


//EM		
		RED.log.info("WampClientInNode(subscriber): role: " + this.role + ". router: " + this.router + ". topic: " + this.topic);



        this.clientNode = RED.nodes.getNode(this.router);

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            switch (this.role) {
                case "subscriber":
				
//EM				
		RED.log.info("WampClientInNode(subscriber): Call to node.wampClient.subscribe().");				
				
                    const filterDoorDirno = (config.door_dirno || "").trim();
                    const filterFromDirno = (config.from_dirno || "").trim();
                    node.wampClient.subscribe(node.topic,
                        function (args, kwargs)
                        {
                            const eventData = (kwargs && typeof kwargs === "object" && Object.keys(kwargs).length) ?
                                kwargs :
                                (Array.isArray(args) && args.length && typeof args[0] === "object" ? args[0] : {});
                            const msg = {topic: node.topic,  payload: {args: args, kwargs: kwargs, data: eventData}};
                            const eventDoorDirno = eventData.door_dirno;
                            const eventFromDirno = eventData.from_dirno;
                            const matchesDoorDirno = !filterDoorDirno || (eventDoorDirno !== undefined && String(eventDoorDirno).indexOf(filterDoorDirno) !== -1);
                            const matchesFromDirno = !filterFromDirno || (eventFromDirno !== undefined && String(eventFromDirno).indexOf(filterFromDirno) !== -1);
                            if (matchesDoorDirno && matchesFromDirno) {
                                node.send(msg);
                            }
                        });
                    break;


                case "calleeReceiver":
                    node.wampClient.registerProcedure(this.topic, function (args, kwargs) {
                        RED.log.debug("procedure: " + args +", " +kwargs);
                        var d = autobahn.when.defer(); // create a deferred
                        var msg = {procedure: this.topic, payload: {args: args, kwargs: kwargs}, _d: d};
                        node.send(msg);
                        return d.promise;
                    });
                    break;


                default:
                    RED.log.error("the role ["+this.role+"] is not recognized.");
                    break;
            }
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("Zenitel Door Open", ZenitelDoorOpen);

//-------------------------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Event|4| Node for directly reading call states on a Zenitel intercom device	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
    function ZenitelCallState(config) {
        RED.nodes.createNode(this, config);
        this.role = "subscriber";
        this.router = config.router;
        this.topic = "com.zenitel.call";


//EM		
		RED.log.info("WampClientInNode(subscriber): role: " + this.role + ". router: " + this.router + ". topic: " + this.topic);



        this.clientNode = RED.nodes.getNode(this.router);

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            switch (this.role) {
                case "subscriber":
				
//EM				
		RED.log.info("WampClientInNode(subscriber): Call to node.wampClient.subscribe().");				
				
                    const filterFromDirno = (config.fromdirno || "").trim();
                    const filterToDirno = (config.todirno || "").trim();
                    const filterCallstate = (config.callstate || "").trim();
                    const filterReason = (config.reason || "").trim();
                    node.wampClient.subscribe(node.topic,
                        function (args, kwargs)
                        {
                            const eventData = (kwargs && typeof kwargs === "object" && Object.keys(kwargs).length) ?
                                kwargs :
                                (Array.isArray(args) && args.length && typeof args[0] === "object" ? args[0] : {});
                            const msg = {topic: node.topic,  payload: {args: args, kwargs: kwargs, data: eventData}};
                            const fromValue = eventData.fromdirno !== undefined ? eventData.fromdirno : eventData.from_dirno;
                            const toValue = eventData.todirno !== undefined ? eventData.todirno : eventData.to_dirno;
                            const stateValue = eventData.callstate !== undefined ? eventData.callstate : (eventData.call_state !== undefined ? eventData.call_state : eventData.state);
                            const reasonValue = eventData.reason !== undefined ? eventData.reason : (eventData.cause !== undefined ? eventData.cause : eventData.reason_code);
                            const matchesFrom = !filterFromDirno || (fromValue !== undefined && String(fromValue).indexOf(filterFromDirno) !== -1);
                            const matchesTo = !filterToDirno || (toValue !== undefined && String(toValue).indexOf(filterToDirno) !== -1);
                            const matchesState = !filterCallstate || (stateValue !== undefined && String(stateValue).indexOf(filterCallstate) !== -1);
                            const matchesReason = !filterReason || (reasonValue !== undefined && String(reasonValue).indexOf(filterReason) !== -1);
                            if (matchesFrom && matchesTo && matchesState && matchesReason) {
                                node.send(msg);
                            }
                        });
                    break;


                case "calleeReceiver":
                    node.wampClient.registerProcedure(this.topic, function (args, kwargs) {
                        RED.log.debug("procedure: " + args +", " +kwargs);
                        var d = autobahn.when.defer(); // create a deferred
                        var msg = {procedure: this.topic, payload: {args: args, kwargs: kwargs}, _d: d};
                        node.send(msg);
                        return d.promise;
                    });
                    break;


                default:
                    RED.log.error("the role ["+this.role+"] is not recognized.");
                    break;
            }
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("Zenitel Call State", ZenitelCallState);

//-------------------------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Event|5| Node for directly reading device states of a Zenitel intercom device	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
     function ZenitelDeviceState(config) {
        RED.nodes.createNode(this, config);
        this.role = "subscriber";
        this.router = config.router;
        this.topic = "com.zenitel.system.device_account";
        this.dirno = config.dirno;
        this.state = config.state


//EM		
		RED.log.info("WampClientInNode(subscriber): role: " + this.role + ". router: " + this.router + ". topic: " + this.topic);



        this.clientNode = RED.nodes.getNode(this.router);

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            switch (this.role) {
                case "subscriber":
				
//EM				
		RED.log.info("WampClientInNode(subscriber): Call to node.wampClient.subscribe().");				
				
                    const filterDirno = (config.dirno || "").trim();
                    const filterState = (config.state || "").trim();
                    const normalizedFilterState = filterState.toLowerCase();
                    node.wampClient.subscribe(node.topic,
                        function (args, kwargs)
                        {
                            const eventData = (kwargs && typeof kwargs === "object" && Object.keys(kwargs).length) ?
                                kwargs :
                                (Array.isArray(args) && args.length && typeof args[0] === "object" ? args[0] : {});
                            const msg = {topic: node.topic,  payload: {args: args, kwargs: kwargs, data: eventData}};
                            RED.log.info("Zenitel Device State node received message: " + JSON.stringify(msg) + " filtering for: dirno: " + config.dirno + " state: " + config.state);
                            const eventDirno = eventData.dirno !== undefined ? eventData.dirno :
                                (eventData.dir_no !== undefined ? eventData.dir_no : eventData.device_id);
                            const eventState = eventData.state !== undefined ? eventData.state :
                                (eventData.status !== undefined ? eventData.status : eventData.device_state);
                            const matchesDirno = !filterDirno ||
                                (eventDirno !== undefined && String(eventDirno).indexOf(filterDirno) !== -1);
                            const matchesState = !filterState ||
                                (eventState !== undefined && String(eventState).toLowerCase() === normalizedFilterState);
                            if (matchesDirno && matchesState) {
                                node.send(msg);
                            }
                        });
                    break;


                case "calleeReceiver":
                    node.wampClient.registerProcedure(this.topic, function (args, kwargs) {
                        RED.log.debug("procedure: " + args +", " +kwargs);
                        var d = autobahn.when.defer(); // create a deferred
                        var msg = {procedure: this.topic, payload: {args: args, kwargs: kwargs}, _d: d};
                        node.send(msg);
                        return d.promise;
                    });
                    break;


                default:
                    RED.log.error("the role ["+this.role+"] is not recognized.");
                    break;
            }
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("Zenitel Device State", ZenitelDeviceState);

//-------------------------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Event|6| Node for directly reading Event triggers from ZCP	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
    function ZenitelEventTrigger(config) {
        RED.nodes.createNode(this, config);
        this.role = "subscriber";
        this.router = config.router;
        this.topic = "com.zenitel.system.event_trigger";


//EM		
		RED.log.info("WampClientInNode(subscriber): role: " + this.role + ". router: " + this.router + ". topic: " + this.topic);



        this.clientNode = RED.nodes.getNode(this.router);

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            switch (this.role) {
                case "subscriber":
				
//EM				
		RED.log.info("WampClientInNode(subscriber): Call to node.wampClient.subscribe().");				
				
                    node.wampClient.subscribe(this.topic,
     					function (args, kwargs)
     					{
							var msg = {topic: this.topic,  payload: {args: args, kwargs: kwargs}
						};
						RED.log.info("Zenitel Event Trigger node received message: " + JSON.stringify(msg) + " filtering for: dirno: " + config.dirno +" eventno: " + config.eventno);
						var ContainsDirno = msg.payload.args[0].from_dirno.includes(config.dirno);
						var ContainsEventno = msg.payload.args[0].to_dirno.includes(config.eventno);
											
						if(ContainsDirno && ContainsEventno){
                        node.send(msg);
						}
                    });
                    break;


                case "calleeReceiver":
                    node.wampClient.registerProcedure(this.topic, function (args, kwargs) {
                        RED.log.debug("procedure: " + args +", " +kwargs);
                        var d = autobahn.when.defer(); // create a deferred
                        var msg = {procedure: this.topic, payload: {args: args, kwargs: kwargs}, _d: d};
                        node.send(msg);
                        return d.promise;
                    });
                    break;


                default:
                    RED.log.error("the role ["+this.role+"] is not recognized.");
                    break;
            }
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("Zenitel Event Trigger", ZenitelEventTrigger);

//-------------------------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Event|7| Node for directly reading extended states of a Zenitel intercom device	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
     function ZenitelExtendedState(config) {
        RED.nodes.createNode(this, config);
        this.role = "subscriber";
        this.router = config.router;
        this.topic = "com.zenitel.system.device.extended_status";


//EM		
		RED.log.info("WampClientInNode(subscriber): role: " + this.role + ". router: " + this.router + ". topic: " + this.topic);



        this.clientNode = RED.nodes.getNode(this.router);

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            switch (this.role) {
                case "subscriber":
				
//EM				
		RED.log.info("WampClientInNode(subscriber): Call to node.wampClient.subscribe().");				
				
                    const filterDirno = (config.dirno || "").trim();
                    const filterTesttype = (config.testtype || "").trim();
                    const filterTestresult = (config.testresult || "").trim();
                    node.wampClient.subscribe(node.topic,
                        function (args, kwargs)
                        {
                            const eventData = (kwargs && typeof kwargs === "object" && Object.keys(kwargs).length) ?
                                kwargs :
                                (Array.isArray(args) && args.length && typeof args[0] === "object" ? args[0] : {});
                            const msg = {topic: node.topic,  payload: {args: args, kwargs: kwargs, data: eventData}};
                            RED.log.info("Zenitel Extended State node received message: " + JSON.stringify(msg) + " filtering for: dirno: " + config.dirno + " testtype: " + config.testtype + " testresult: " + config.testresult);
                            const eventDirno = eventData.dirno !== undefined ? eventData.dirno :
                                (eventData.dir_no !== undefined ? eventData.dir_no : eventData.device_id);
                            const eventTesttype = eventData.status_type !== undefined ? eventData.status_type :
                                (eventData.test_type !== undefined ? eventData.test_type : eventData.type);
                            const eventTestresult = eventData.current_status !== undefined ? eventData.current_status :
                                (eventData.result !== undefined ? eventData.result : eventData.status);
                            const matchesDirno = !filterDirno ||
                                (eventDirno !== undefined && String(eventDirno).indexOf(filterDirno) !== -1);
                            const matchesTesttype = !filterTesttype ||
                                (eventTesttype !== undefined && String(eventTesttype).indexOf(filterTesttype) !== -1);
                            const matchesTestresult = !filterTestresult ||
                                (eventTestresult !== undefined && String(eventTestresult).indexOf(filterTestresult) !== -1);
                            if (matchesDirno && matchesTesttype && matchesTestresult) {
                                node.send(msg);
                            }
                        });
                    break;


                case "calleeReceiver":
                    node.wampClient.registerProcedure(this.topic, function (args, kwargs) {
                        RED.log.debug("procedure: " + args +", " +kwargs);
                        var d = autobahn.when.defer(); // create a deferred
                        var msg = {procedure: this.topic, payload: {args: args, kwargs: kwargs}, _d: d};
                        node.send(msg);
                        return d.promise;
                    });
                    break;


                default:
                    RED.log.error("the role ["+this.role+"] is not recognized.");
                    break;
            }
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("Zenitel Extended State", ZenitelExtendedState);

//-------------------------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Action Nodes below	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Action|9| Generic Zenitel WAMP call node	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
    function WampClientCallNode(config) {
        RED.nodes.createNode(this, config);
        this.router = config.router;
        this.procedure = config.procedure;

        this.clientNode = RED.nodes.getNode(this.router)

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            node.on("input", function (msg, send, done) {
                send = send || node.send;

                const payload = ensurePayloadObject(msg);
                const callMessage = wrapWampCallPayload(payload);

                const result = node.wampClient.callProcedure(node.procedure, callMessage);
                handleWampCallResult(result, node, msg, send, done);
            });
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("Zenitel WAMP Out", WampClientCallNode);
	
	//-------------------------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Action|1| Node for directly setting up calls on a Zenitel intercom device	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
  function ZenitelCallSetup(config) {
    RED.nodes.createNode(this, config);

    this.router    = config.router;
    this.procedure = 'com.zenitel.calls.post';
    this.fromdirno = config.fromdirno;
    this.todirno   = config.todirno;
    this.priority  = config.priority;

    this.clientNode = RED.nodes.getNode(this.router);

    if (this.clientNode) {
        const node = this;
        node.wampClient = this.clientNode.wampClient();

        this.clientNode.on("ready", function () {
            node.status({ fill: "green", shape: "dot", text: "node-red:common.status.connected" });
        });
        this.clientNode.on("closed", function () {
            node.status({ fill: "red", shape: "ring", text: "node-red:common.status.not-connected" });
        });

        node.on("input", function (msg, send, done) {
            send = send || node.send;

            const payload = ensurePayloadObject(msg);

                assignConfigValue(payload, node.fromdirno, ["from_dirno"]);
                assignConfigValue(payload, node.todirno, ["to_dirno"]);
                if (node.priority !== undefined && node.priority !== "") {
                    payload.priority = node.priority;
                }

                if (payload.from_dirno !== undefined) payload.from_dirno = String(payload.from_dirno);
                if (payload.to_dirno !== undefined) payload.to_dirno = String(payload.to_dirno);
                

                let pr = payload.priority;
                if (pr === undefined || pr === "") {
                    pr = "40";
                } else {
                    pr = String(pr);
                }
                payload.priority = pr;

            const missing = findMissingAliases(payload, [["from_dirno"], ["to_dirno"]]);
            if (missing.length) {
                reportMissing(node, msg, send, done, missing);
                return;
            }

            if (payload.action === undefined || payload.action === "") {
                payload.action = "setup";
            }
            if (payload.verbose === undefined) {
                payload.verbose = false;
            }

            const callMessage = wrapWampCallPayload(payload);
            const result = node.wampClient.callProcedure(node.procedure, callMessage);
            handleWampCallResult(result, node, msg, send, done);
        });
    } else {
        RED.log.error("wamp client config is missing!");
    }

    this.on("close", function (done) {
        if (this.clientNode) {
            this.clientNode.close(done);
        } else {
            done();
        }
    });
}
RED.nodes.registerType("Zenitel Call Setup", ZenitelCallSetup);

	
//-------------------------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Action|2| Node for directly playing an audio message on a Zenitel intercom device	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
    function ZenitelPlayAudioMessage(config) {
        RED.nodes.createNode(this, config);
        this.router = config.router;
        this.procedure = 'com.zenitel.calls.post';
		this.audiomsgdirno = config.audiomsgdirno;
        this.todirno = config.todirno;
        this.clientNode = RED.nodes.getNode(this.router)

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            node.on("input", function (msg, send, done) {
                send = send || node.send;

                const payload = ensurePayloadObject(msg);

                assignConfigValue(payload, node.audiomsgdirno, ["audio_msg_dirno", "audiomsgdirno", "from_dirno", "fromdirno"]);
                assignConfigValue(payload, node.todirno, ["to_dirno", "todirno"]);

                syncAliases(payload, ["audio_msg_dirno", "audiomsgdirno", "from_dirno", "fromdirno"]);
                syncAliases(payload, ["to_dirno", "todirno"]);

                if (payload.from_dirno === undefined && payload.audio_msg_dirno !== undefined) {
                    payload.from_dirno = payload.audio_msg_dirno;
                }
                if (payload.fromdirno === undefined && payload.from_dirno !== undefined) {
                    payload.fromdirno = payload.from_dirno;
                }
                if (payload.audio_msg_dirno === undefined && payload.from_dirno !== undefined) {
                    payload.audio_msg_dirno = payload.from_dirno;
                }

                if (payload.from_dirno !== undefined) payload.from_dirno = String(payload.from_dirno);
                if (payload.fromdirno !== undefined) payload.fromdirno = String(payload.fromdirno);
                if (payload.audio_msg_dirno !== undefined) payload.audio_msg_dirno = String(payload.audio_msg_dirno);
                if (payload.audiomsgdirno !== undefined) payload.audiomsgdirno = String(payload.audiomsgdirno);
                if (payload.to_dirno !== undefined) payload.to_dirno = String(payload.to_dirno);
                if (payload.todirno !== undefined) payload.todirno = String(payload.todirno);

                let pr = payload.priority;
                if (pr === undefined || pr === "") {
                    pr = "40";
                } else {
                    pr = String(pr);
                }
                payload.priority = pr;

                if (payload.to_dirno && !payload.todirno) payload.todirno = payload.to_dirno;
                if (payload.todirno && !payload.to_dirno) payload.to_dirno = payload.todirno;

                const missing = findMissingAliases(payload, [["from_dirno", "fromdirno"], ["to_dirno", "todirno"]]);
                if (missing.length) {
                    reportMissing(node, msg, send, done, missing);
                    return;
                }

                if (payload.action === undefined || payload.action === "") {
                    payload.action = "setup";
                }
                if (payload.verbose === undefined) {
                    payload.verbose = false;
                }

                const callMessage = wrapWampCallPayload(payload);
                const result = node.wampClient.callProcedure(node.procedure, callMessage);
                handleWampCallResult(result, node, msg, send, done);
            });
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("Zenitel Play Audio Message", ZenitelPlayAudioMessage);
	
//-------------------------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Action|3| Node for directly door opening on a Zenitel intercom device	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
    function ZenitelDoorOpener(config) {
        RED.nodes.createNode(this, config);
        this.router = config.router;
        this.procedure = 'com.zenitel.calls.call.open_door.post';
		this.dirno = config.dirno;
        this.clientNode = RED.nodes.getNode(this.router)

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            node.on("input", function (msg, send, done) {
                send = send || node.send;

                const payload = ensurePayloadObject(msg);

                assignConfigValue(payload, node.dirno, ["from_dirno"]);
                syncAliases(payload, ["from_dirno"]);

                const missing = findMissingAliases(payload, [["from_dirno"]]);
                if (missing.length) {
                    reportMissing(node, msg, send, done, missing);
                    return;
                }

                const callMessage = wrapWampCallPayload(payload);
                const result = node.wampClient.callProcedure(node.procedure, callMessage);
                handleWampCallResult(result, node, msg, send, done);
            });
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("Zenitel Door Opener", ZenitelDoorOpener);
	
//-------------------------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Action|4| Node for triggering an output on a Zenitel intercom device	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
    function ZenitelGPOTrigger(config) {
        RED.nodes.createNode(this, config);
        this.router = config.router;
        this.procedure = 'com.zenitel.devices.device.gpos.gpo.post';
		this.dirno = config.dirno;
        this.GPoutput = config.GPoutput;
		this.GPaction = config.GPaction;
		this.ontime = config.ontime;
        this.clientNode = RED.nodes.getNode(this.router)

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            node.on("input", function (msg, send, done) {
                send = send || node.send;

                const payload = ensurePayloadObject(msg);

                assignConfigValue(payload, node.dirno, ["dirno"]);
                assignConfigValue(payload, node.GPoutput, ["id", "output", "gp_output", "GPoutput"]);
                assignConfigValue(payload, node.GPaction, ["operation", "action", "state", "GPaction"]);
                assignConfigValue(payload, node.ontime, ["time", "on_time", "ontime"]);

                function firstDefined() {
                    for (let i = 0; i < arguments.length; i++) {
                        const val = payload[arguments[i]];
                        if (val !== undefined && val !== null && String(val).trim() !== "") {
                            return val;
                        }
                    }
                    return undefined;
                }

                function normalizeOperation(value) {
                    if (value === undefined || value === null) {
                        return undefined;
                    }
                    const lower = String(value).trim().toLowerCase();
                    switch (lower) {
                        case "on":
                        case "set":
                            return "set";
                        case "off":
                        case "clear":
                            return "clear";
                        case "slow_blink":
                        case "slowblink":
                        case "slow-blink":
                        case "slow blink":
                            return "slow_blink";
                        case "fast_blink":
                        case "fastblink":
                        case "fast-blink":
                        case "fast blink":
                            return "fast_blink";
                        case "timed on":
                        case "timed_on":
                        case "set_timed":
                        case "settimed":
                        case "set-timed":
                        case "timed":
                            return "set_timed";
                        default:
                            return lower;
                    }
                }
                const allowedOperations = new Set(["set", "clear", "slow_blink", "fast_blink", "set_timed"]);

                const dirnoValue = firstDefined("dirno");
                const gpoValue = firstDefined("id", "output", "gp_output", "GPoutput");
                let dirno = dirnoValue !== undefined && dirnoValue !== null ? String(dirnoValue).trim() : "";
                let gpoId = gpoValue !== undefined && gpoValue !== null ? String(gpoValue).trim() : "";
                let operation = normalizeOperation(firstDefined("operation", "action", "state", "GPaction"));
                let timeValue = firstDefined("time", "on_time", "ontime");

                const validationErrors = [];
                if (!dirno) {
                    validationErrors.push("dirno");
                }
                if (!gpoId) {
                    validationErrors.push("id");
                }
                if (!operation || !allowedOperations.has(operation)) {
                    validationErrors.push("operation");
                }

                let numericTime;
                if (timeValue !== undefined && timeValue !== null && String(timeValue).trim() !== "") {
                    numericTime = Number(timeValue);
                    if (!Number.isFinite(numericTime) || numericTime < 0) {
                        const text = "Invalid time value. Provide a non-negative number.";
                        node.status({ fill: "red", shape: "dot", text: text });
                        node.error(text, msg);
                        msg.error = text;
                        send(msg);
                        if (done) done(text);
                        return;
                    }
                }

                if (operation === "set_timed" && numericTime === undefined) {
                    validationErrors.push("time");
                }

                if (validationErrors.length) {
                    reportMissing(node, msg, send, done, validationErrors);
                    return;
                }

                const request = {
                    dirno: dirno,
                    id: gpoId,
                    operation: operation
                };
                if (numericTime !== undefined) {
                    request.time = numericTime;
                }

                msg.payload = request;

                const callMessage = wrapWampCallPayload(request);
                const result = node.wampClient.callProcedure(node.procedure, callMessage);
                handleWampCallResult(result, node, msg, send, done);
            });
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("Zenitel GPO Trigger", ZenitelGPOTrigger);
	
//-------------------------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Action|5| Node for simulate a key press on a Zenitel intercom device	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
    function ZenitelKeyPress(config) {
        RED.nodes.createNode(this, config);
        this.router = config.router;
        this.procedure = 'com.zenitel.devices.device.key.post';
		this.dirno = config.dirno;
        this.buttonkey = config.buttonkey;
        this.action = config.action;
        this.clientNode = RED.nodes.getNode(this.router)

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            node.on("input", function (msg, send, done) {
                send = send || node.send;

                const payload = ensurePayloadObject(msg);

                assignConfigValue(payload, node.dirno, ["dirno"]);
                assignConfigValue(payload, node.buttonkey, ["id"]);
                assignConfigValue(payload, node.action, ["edge", "action"]);

                syncAliases(payload, ["dirno"]);
                syncAliases(payload, ["id"]);
                syncAliases(payload, ["edge", "action"]);

                if (payload.edge === undefined || payload.edge === null || payload.edge === "") {
                    payload.edge = "tap";
                    syncAliases(payload, ["edge", "action"]);
                }

                const missing = findMissingAliases(payload, [["dirno"], ["id"]]);
                if (missing.length) {
                    reportMissing(node, msg, send, done, missing);
                    return;
                }

                const callMessage = wrapWampCallPayload(payload);
                const result = node.wampClient.callProcedure(node.procedure, callMessage);
                handleWampCallResult(result, node, msg, send, done);
            });
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("Zenitel Key Press", ZenitelKeyPress);
	
//-------------------------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Action|6| Node for setting call forwarding on a Zenitel intercom device	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
    function ZenitelCallForwarding(config) {
        RED.nodes.createNode(this, config);
        this.router = config.router;
        this.procedure = 'com.zenitel.call_forwarding.post';
		this.dirno = config.dirno;
        this.fwddirno = config.fwddirno;
		this.rule = config.rule;
        this.enable = config.enable;
        this.clientNode = RED.nodes.getNode(this.router)

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            node.on("input", function (msg, send, done) {
                send = send || node.send;

                const payloadItems = Array.isArray(msg.payload) ? msg.payload : [ensurePayloadObject(msg)];

                if (!payloadItems.length) {
                    reportMissing(node, msg, send, done, ["dirno", "fwd_type", "fwd_to", "enabled"]);
                    return;
                }

                const rules = [];
                const missingDetails = [];

                payloadItems.forEach(function (item, index) {
                    if (typeof item !== "object" || item === null) {
                        item = {};
                        payloadItems[index] = item;
                    }

                    assignConfigValue(item, node.dirno, ["dirno"]);
                    assignConfigValue(item, node.fwddirno, ["fwddirno", "forward_dirno", "to_dirno", "todirno", "fwd_to"]);
                    assignConfigValue(item, node.rule, ["rule", "fwd_type"]);
                    assignConfigValue(item, node.enable, ["enable", "enabled"]);

                    syncAliases(item, ["dirno"]);
                    syncAliases(item, ["fwddirno", "forward_dirno", "to_dirno", "todirno", "fwd_to"]);
                    syncAliases(item, ["rule", "fwd_type"]);
                    syncAliases(item, ["enable", "enabled"]);

                    let enabledValue = item.enabled !== undefined ? item.enabled : item.enable;
                    if (typeof enabledValue === "string") {
                        const lower = enabledValue.trim().toLowerCase();
                        if (lower === "true" || lower === "enable" || lower === "enabled" || lower === "on") {
                            enabledValue = true;
                        } else if (lower === "false" || lower === "disable" || lower === "disabled" || lower === "off") {
                            enabledValue = false;
                        } else {
                            enabledValue = undefined;
                        }
                    }

                    const ruleObject = {
                        dirno: item.dirno,
                        fwd_type: item.fwd_type || item.rule,
                        fwd_to: item.fwd_to || item.fwddirno || item.forward_dirno || item.to_dirno || item.todirno,
                        enabled: enabledValue
                    };

                    const missing = [];
                    if (!ruleObject.dirno) { missing.push("dirno"); }
                    if (!ruleObject.fwd_type) { missing.push("fwd_type"); }
                    if (!ruleObject.fwd_to) { missing.push("fwd_to"); }
                    if (ruleObject.enabled === undefined) { missing.push("enabled"); }

                    if (missing.length) {
                        missingDetails.push("rule[" + index + "]: " + missing.join(", "));
                    } else {
                        rules.push(ruleObject);
                    }
                });

                if (missingDetails.length) {
                    const text = "Missing required fields: " + missingDetails.join("; ");
                    node.status({ fill: "red", shape: "dot", text: text });
                    node.error(text, msg);
                    msg.error = text;
                    send(msg);
                    if (done) done(text);
                    return;
                }

                const callMessage = { args: [rules], kwargs: {} };
                const result = node.wampClient.callProcedure(node.procedure, callMessage);
                handleWampCallResult(result, node, msg, send, done);
            });
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("Zenitel Setup Call Forwarding", ZenitelCallForwarding);
	
//-------------------------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Action|7| Node for executing a button test on a Zenitel intercom device	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
    function ZenitelButtonTest(config) {
        RED.nodes.createNode(this, config);
        this.router = config.router;
        this.procedure = 'com.zenitel.system.devices.test.button.post';
		this.dirno = config.dirno;
        this.clientNode = RED.nodes.getNode(this.router)

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            node.on("input", function (msg, send, done) {
                send = send || node.send;

                const payload = ensurePayloadObject(msg);

                assignConfigValue(payload, node.dirno, ["dirno"]);
                syncAliases(payload, ["dirno"]);

                const missing = findMissingAliases(payload, [["dirno"]]);
                if (missing.length) {
                    reportMissing(node, msg, send, done, missing);
                    return;
                }

                const callMessage = wrapWampCallPayload(payload);
                const result = node.wampClient.callProcedure(node.procedure, callMessage);
                handleWampCallResult(result, node, msg, send, done);
            });
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("Zenitel Button Test", ZenitelButtonTest);
	
//-------------------------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Action|8| Node for executing a tone test on a Zenitel intercom device	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
    function ZenitelToneTest(config) {
        RED.nodes.createNode(this, config);
        this.router = config.router;
        this.procedure = 'com.zenitel.system.devices.test.tone.post';
		this.dirno = config.dirno;
        this.clientNode = RED.nodes.getNode(this.router)

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            node.on("input", function (msg, send, done) {
                send = send || node.send;

                const payload = ensurePayloadObject(msg);

                assignConfigValue(payload, node.dirno, ["dirno"]);
                syncAliases(payload, ["dirno"]);

                const missing = findMissingAliases(payload, [["dirno"]]);
                if (missing.length) {
                    reportMissing(node, msg, send, done, missing);
                    return;
                }

                const callMessage = wrapWampCallPayload(payload);
                const result = node.wampClient.callProcedure(node.procedure, callMessage);
                handleWampCallResult(result, node, msg, send, done);
            });
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("Zenitel Tone Test", ZenitelToneTest);

    //-------------------------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Action|10| Node for directly ending a call on a Zenitel intercom device	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
	
//-------------------------------------------------------------------------------------------------------------------
function ZenitelCallEnd(config) {
        RED.nodes.createNode(this, config);
        this.router = config.router;
        this.procedure = 'com.zenitel.calls.delete';
		this.dirno = config.dirno;
        this.clientNode = RED.nodes.getNode(this.router)

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            node.on("input", function (msg, send, done) {
                send = send || node.send;

                const payload = ensurePayloadObject(msg);

                assignConfigValue(payload, node.dirno, ["dirno"]);
                syncAliases(payload, ["dirno"]);

                const missing = findMissingAliases(payload, [["dirno"]]);
                if (missing.length) {
                    reportMissing(node, msg, send, done, missing);
                    return;
                }

                const callMessage = wrapWampCallPayload(payload);
                const result = node.wampClient.callProcedure(node.procedure, callMessage);
                handleWampCallResult(result, node, msg, send, done);
            });
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("Zenitel Call End", ZenitelCallEnd);

    //-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Action|11|  Node for directly ending audio message	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
	
//-------------------------------------------------------------------------------------------------------------------
function ZenitelAudioMessageEnd(config) {
        RED.nodes.createNode(this, config);
        this.router = config.router;
        this.procedure = 'com.zenitel.calls.delete';
		this.dirno = config.dirno;
        this.clientNode = RED.nodes.getNode(this.router)

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            node.on("input", function (msg, send, done) {
                send = send || node.send;

                const payload = ensurePayloadObject(msg);

                assignConfigValue(payload, node.dirno, ["dirno"]);
                syncAliases(payload, ["dirno"]);

                const missing = findMissingAliases(payload, [["dirno"]]);
                if (missing.length) {
                    reportMissing(node, msg, send, done, missing);
                    return;
                }

                const callMessage = wrapWampCallPayload(payload);
                const result = node.wampClient.callProcedure(node.procedure, callMessage);
                handleWampCallResult(result, node, msg, send, done);
            });
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("Zenitel Audio Message End", ZenitelAudioMessageEnd);

    //-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Action|12| Node for deleting call forwarding rules	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
	
//-------------------------------------------------------------------------------------------------------------------
    function ZenitelDeleteCallForwarding(config) {
        RED.nodes.createNode(this, config);
        this.router = config.router;
        this.procedure = 'com.zenitel.call_forwarding.delete';
		this.dirno = config.dirno;
        this.fwd_type = config.fwd_type || config.rule;
        this.clientNode = RED.nodes.getNode(this.router)

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            node.on("input", function (msg, send, done) {
                send = send || node.send;

                const payload = ensurePayloadObject(msg);

                assignConfigValue(payload, node.dirno, ["dirno"]);
                assignConfigValue(payload, node.fwd_type, ["fwd_type", "rule"]);
                syncAliases(payload, ["dirno"]);
                syncAliases(payload, ["fwd_type", "rule"]);

                const missing = findMissingAliases(payload, [["dirno"], ["fwd_type", "rule"]]);
                if (missing.length) {
                    reportMissing(node, msg, send, done, missing);
                    return;
                }

                if (payload.rule !== undefined) {
                    delete payload.rule;
                }

                const callMessage = wrapWampCallPayload(payload);
                const result = node.wampClient.callProcedure(node.procedure, callMessage);
                handleWampCallResult(result, node, msg, send, done);
            });
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("Zenitel Delete Call Forwarding", ZenitelDeleteCallForwarding);


    //-------------------------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Request|1| Node for requesting device accounts	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//-------------------------------------------------------------------------------------------------------------------
		
function ZenitelDeviceAccountRequest(config) {
        RED.nodes.createNode(this, config);
        this.router = config.router;
        this.procedure = 'com.zenitel.system.device_accounts';
        this.state = config.state;
        this.clientNode = RED.nodes.getNode(this.router);

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            node.on("input", function (msg, send, done) {
                send = send || node.send;

                const payload = ensurePayloadObject(msg);

                assignConfigValue(payload, node.state, ["state"]);
                syncAliases(payload, ["state"]);

                const request = Object.assign({}, payload);

                if (request.state !== undefined && request.state !== null && request.state !== "") {
                    let normalizedState = String(request.state).trim().toLowerCase();
                    if (normalizedState === "all" || normalizedState === "*") {
                        delete request.state;
                    } else {
                        request.state = normalizedState;
                    }
                } else if (request.state !== undefined) {
                    delete request.state;
                }

                const callPayload = Object.keys(request).length ? request : undefined;
                const callMessage = wrapWampCallPayload(callPayload);
                const result = node.wampClient.callProcedure(node.procedure, callMessage);
                handleWampCallResult(result, node, msg, send, done);
            });
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("Zenitel Device Account Request", ZenitelDeviceAccountRequest);

    //-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Request|2| Node for requesting audio messages
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//-------------------------------------------------------------------------------------------------------------------


  function ZenitelAudioMessageRequest(config) {
    RED.nodes.createNode(this, config);
    this.router = config.router;
    this.procedure = "com.zenitel.system.audio_messages"; 
    this.clientNode = RED.nodes.getNode(this.router);

    if (!this.clientNode) {
      RED.log.error("wamp client config is missing!");
      return;
    }

    const node = this;
    node.wampClient = this.clientNode.wampClient();

    this.clientNode.on("ready", function () {
      node.status({ fill: "green", shape: "dot", text: "node-red:common.status.connected" });
    });
    this.clientNode.on("closed", function () {
      node.status({ fill: "red", shape: "ring", text: "node-red:common.status.not-connected" });
    });

    node.on("input", function (msg, send, done) {
      send = send || node.send;

     
      const callMessage = wrapWampCallPayload(); 
      const result = node.wampClient.callProcedure(node.procedure, callMessage);

      handleWampCallResult(result, node, msg, send, done);
    });

    this.on("close", function (done) {
      if (this.clientNode) this.clientNode.close(done);
      else done();
    });
  }

  RED.nodes.registerType("Zenitel Audio Message Request", ZenitelAudioMessageRequest);

  //-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Request|3|  Node for requesting groups	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//-------------------------------------------------------------------------------------------------------------------
function ZenitelGroupsRequest(config) {
    RED.nodes.createNode(this, config);
    this.router = config.router;
    this.procedure = "com.zenitel.groups"; 
    this.groupdirno = config.groupdirno;
    this.verbose = config.verbose;
    this.clientNode = RED.nodes.getNode(this.router);

    if (!this.clientNode) {
      RED.log.error("wamp client config is missing!");
      return;
    }

    const node = this;
    node.wampClient = this.clientNode.wampClient();

    this.clientNode.on("ready", function () {
      node.status({ fill: "green", shape: "dot", text: "node-red:common.status.connected" });
    });
    this.clientNode.on("closed", function () {
      node.status({ fill: "red", shape: "ring", text: "node-red:common.status.not-connected" });
    });

    node.on("input", function (msg, send, done) {
      send = send || node.send;

      const payload = ensurePayloadObject(msg);

      let dirno = payload.dirno;
      if (!dirno) {
        dirno = payload.groupdirno;
      }
      if (!dirno) {
        dirno = node.groupdirno;
      }

      if (dirno !== undefined && dirno !== null) {
        dirno = String(dirno).trim();
        if (dirno === "") {
          dirno = undefined;
        }
      }

      let verbose = payload.verbose;
      if (verbose === undefined || verbose === null || verbose === "") {
        verbose = node.verbose;
      }

      if (verbose !== undefined && verbose !== null && verbose !== "") {
        if (typeof verbose === "string") {
          verbose = verbose.trim().toLowerCase();
          if (verbose === "true" || verbose === "yes" || verbose === "1") {
            verbose = true;
          } else if (verbose === "false" || verbose === "no" || verbose === "0") {
            verbose = false;
          } else {
            verbose = undefined;
          }
        } else {
          verbose = Boolean(verbose);
        }
      } else if (verbose === "") {
        verbose = undefined;
      }

      let callPayload;
      if (dirno || verbose !== undefined) {
        callPayload = {};
        if (dirno) callPayload.dirno = dirno;
        if (verbose !== undefined) callPayload.verbose = verbose;
      }
      const callMessage = wrapWampCallPayload(callPayload); 
      const result = node.wampClient.callProcedure(node.procedure, callMessage);

      handleWampCallResult(result, node, msg, send, done);
    });

    this.on("close", function (done) {
      if (this.clientNode) this.clientNode.close(done);
      else done();
    });
  }

  RED.nodes.registerType("Zenitel Groups Request", ZenitelGroupsRequest);


  //-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Request|4|  Node for requesting directory	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//-------------------------------------------------------------------------------------------------------------------
function ZenitelDirectoryRequest(config) {
    RED.nodes.createNode(this, config);
    this.router = config.router;
    this.procedure = "com.zenitel.directory"; 
    this.dirno = config.dirno;
    this.clientNode = RED.nodes.getNode(this.router);

    if (!this.clientNode) {
      RED.log.error("wamp client config is missing!");
      return;
    }

    const node = this;
    node.wampClient = this.clientNode.wampClient();

    this.clientNode.on("ready", function () {
      node.status({ fill: "green", shape: "dot", text: "node-red:common.status.connected" });
    });
    this.clientNode.on("closed", function () {
      node.status({ fill: "red", shape: "ring", text: "node-red:common.status.not-connected" });
    });

    node.on("input", function (msg, send, done) {
      send = send || node.send;

      const payload = ensurePayloadObject(msg);

      let dirno = payload.dirno;
      if (!dirno) {
        dirno = payload.dirno;
      }
      if (!dirno) {
        dirno = node.dirno;
      }

      if (dirno !== undefined && dirno !== null) {
        dirno = String(dirno).trim();
        if (dirno === "") {
          dirno = undefined;
        }
      }

      const callPayload = dirno ? { dirno: dirno } : undefined;
      const callMessage = wrapWampCallPayload(callPayload); 
      const result = node.wampClient.callProcedure(node.procedure, callMessage);

      handleWampCallResult(result, node, msg, send, done);
    });

    this.on("close", function (done) {
      if (this.clientNode) this.clientNode.close(done);
      else done();
    });
  }

  RED.nodes.registerType("Zenitel Directory Request", ZenitelDirectoryRequest);

  //-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Request|5|  Node for requesting call forwarding rules
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//-------------------------------------------------------------------------------------------------------------------


  function ZenitelCallForwardingRequest(config) {
    RED.nodes.createNode(this, config);
    this.router = config.router;
    this.procedure = "com.zenitel.call_forwarding"; 
    this.dirno = config.dirno;
    this.fwdType = config.fwd_type;
    this.clientNode = RED.nodes.getNode(this.router);

    if (!this.clientNode) {
      RED.log.error("wamp client config is missing!");
      return;
    }

    const node = this;
    node.wampClient = this.clientNode.wampClient();

    this.clientNode.on("ready", function () {
      node.status({ fill: "green", shape: "dot", text: "node-red:common.status.connected" });
    });
    this.clientNode.on("closed", function () {
      node.status({ fill: "red", shape: "ring", text: "node-red:common.status.not-connected" });
    });

    node.on("input", function (msg, send, done) {
      send = send || node.send;

      const payload = ensurePayloadObject(msg);

      let dirno = payload.dirno;
      if (dirno === undefined || dirno === null || dirno === "") {
        dirno = node.dirno;
      }

      let fwd_type = payload.fwd_type;
      if (fwd_type === undefined || fwd_type === null || fwd_type === "") {
        fwd_type = node.fwdType;
      }

      if (dirno !== undefined && dirno !== null) {
        dirno = String(dirno).trim();
        if (dirno === "") dirno = undefined;
      }

      if (fwd_type !== undefined && fwd_type !== null) {
        fwd_type = String(fwd_type).trim();
        if (fwd_type === "" || fwd_type.toLowerCase() === "all" || fwd_type === "*") {
          fwd_type = undefined;
        }
      }

      let callPayload;
      if (dirno || fwd_type) {
        callPayload = {};
        if (dirno) callPayload.dirno = dirno;
        if (fwd_type) callPayload.fwd_type = fwd_type;
      }

      const callMessage = wrapWampCallPayload(callPayload); 
      const result = node.wampClient.callProcedure(node.procedure, callMessage);

      handleWampCallResult(result, node, msg, send, done);
    });

    this.on("close", function (done) {
      if (this.clientNode) this.clientNode.close(done);
      else done();
    });
  }

  RED.nodes.registerType("Zenitel Call Forwarding Request", ZenitelCallForwardingRequest);
   //-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Request|6| Node for requesting current calls
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//-------------------------------------------------------------------------------------------------------------------


  function ZenitelCurrentCallsRequest(config) {
    RED.nodes.createNode(this, config);
    this.router = config.router;
    this.procedure = "com.zenitel.calls"; 
    this.clientNode = RED.nodes.getNode(this.router);
    this.fromDirno = config.fromdirno || config.from_dirno;
    this.toDirno = config.todirno || config.to_dirno;
    this.state = config.state;
    this.verbose = config.verbose;

    if (!this.clientNode) {
      RED.log.error("wamp client config is missing!");
      return;
    }

    const node = this;
    node.wampClient = this.clientNode.wampClient();

    this.clientNode.on("ready", function () {
      node.status({ fill: "green", shape: "dot", text: "node-red:common.status.connected" });
    });
    this.clientNode.on("closed", function () {
      node.status({ fill: "red", shape: "ring", text: "node-red:common.status.not-connected" });
    });

    node.on("input", function (msg, send, done) {
      send = send || node.send;

      const payload = ensurePayloadObject(msg);

      let from = payload.from_dirno !== undefined ? payload.from_dirno : payload.fromDirno;
      if (from === undefined) {
        from = payload.fromdirno;
      }
      if (from === undefined || from === null || from === "") {
        from = node.fromDirno;
      }

      let to = payload.to_dirno !== undefined ? payload.to_dirno : payload.toDirno;
      if (to === undefined) {
        to = payload.todirno;
      }
      if (to === undefined || to === null || to === "") {
        to = node.toDirno;
      }

      let state = payload.state;
      if (state === undefined || state === null || state === "") {
        state = node.state;
      }

      let verbose = payload.verbose;
      if (verbose === undefined || verbose === null || verbose === "") {
        verbose = node.verbose;
      }

      if (from !== undefined && from !== null) {
        from = String(from).trim();
        if (from === "") from = undefined;
      }

      if (to !== undefined && to !== null) {
        to = String(to).trim();
        if (to === "") to = undefined;
      }

      if (state !== undefined && state !== null) {
        state = String(state).trim();
        if (state === "" || state.toLowerCase() === "all" || state === "*") {
          state = undefined;
        }
      }

      if (verbose !== undefined && verbose !== null && verbose !== "") {
        if (typeof verbose === "string") {
          verbose = verbose.trim().toLowerCase();
          if (verbose === "true" || verbose === "yes" || verbose === "1") {
            verbose = true;
          } else if (verbose === "false" || verbose === "no" || verbose === "0") {
            verbose = false;
          } else {
            verbose = undefined;
          }
        } else {
          verbose = Boolean(verbose);
        }
      } else if (verbose === "") {
        verbose = undefined;
      }

      let callPayload;
      if (from || to || state || verbose !== undefined) {
        callPayload = {};
        if (from) callPayload.from_dirno = from;
        if (to) callPayload.to_dirno = to;
        if (state) callPayload.state = state;
        if (verbose !== undefined) callPayload.verbose = verbose;
      }

      const callMessage = wrapWampCallPayload(callPayload); 
      const result = node.wampClient.callProcedure(node.procedure, callMessage);

      handleWampCallResult(result, node, msg, send, done);
    });

    this.on("close", function (done) {
      if (this.clientNode) this.clientNode.close(done);
      else done();
    });
  }

  RED.nodes.registerType("Zenitel Current Calls", ZenitelCurrentCallsRequest);

  
  //-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Request|7|  Node for requesting current call queues	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//-------------------------------------------------------------------------------------------------------------------
function ZenitelCallQueueRequest(config) {
    RED.nodes.createNode(this, config);
    this.router = config.router;
    this.procedure = "com.zenitel.call_queues"; 
    this.queue_dirno = config.queue_dirno;
    this.clientNode = RED.nodes.getNode(this.router);

    if (!this.clientNode) {
      RED.log.error("wamp client config is missing!");
      return;
    }

    const node = this;
    node.wampClient = this.clientNode.wampClient();

    this.clientNode.on("ready", function () {
      node.status({ fill: "green", shape: "dot", text: "node-red:common.status.connected" });
    });
    this.clientNode.on("closed", function () {
      node.status({ fill: "red", shape: "ring", text: "node-red:common.status.not-connected" });
    });

    node.on("input", function (msg, send, done) {
      send = send || node.send;

      const payload = ensurePayloadObject(msg);

      let queue_dirno = payload.queue_dirno;
      if (!queue_dirno) {
        queue_dirno = payload.queue_dirno;
      }
      if (!queue_dirno) {
        queue_dirno = node.queue_dirno;
      }

      if (queue_dirno !== undefined && queue_dirno !== null) {
        queue_dirno = String(queue_dirno).trim();
        if (queue_dirno === "") {
          queue_dirno = undefined;
        }
      }

      const callPayload = queue_dirno ? { queue_dirno: queue_dirno } : undefined;
      const callMessage = wrapWampCallPayload(callPayload); 
      const result = node.wampClient.callProcedure(node.procedure, callMessage);

      handleWampCallResult(result, node, msg, send, done);
    });

    this.on("close", function (done) {
      if (this.clientNode) this.clientNode.close(done);
      else done();
    });
  }

  RED.nodes.registerType("Zenitel Current Call Queues", ZenitelCallQueueRequest);

  //-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Action|9| Generic Zenitel WAMP call node	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
    function ZenitelWAMPRequest(config) {
        RED.nodes.createNode(this, config);
        this.router = config.router;
        this.procedure = config.procedure;

        this.clientNode = RED.nodes.getNode(this.router)

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            node.on("input", function (msg, send, done) {
                send = send || node.send;

                const payload = ensurePayloadObject(msg);
                const callMessage = wrapWampCallPayload(payload);

                const result = node.wampClient.callProcedure(node.procedure, callMessage);
                handleWampCallResult(result, node, msg, send, done);
            });
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("Zenitel WAMP Request", ZenitelWAMPRequest);



    function WampClientSubscribe(config)
	{
        RED.nodes.createNode(this, config);
        this.router = config.router;
        this.procedure = config.procedure;

	
        this.clientNode = RED.nodes.getNode(this.router)

		RED.log.info("WampClientSubscribe() Enter.");	

        if (this.clientNode)
		{
			RED.log.info("WampClientSubscribe() ClientNode OK.");

            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            node.on("input",
				function (msg)
    			{
 
					this.topic = msg.topic;

                    node.wampClient.subscribe(this.topic,
     					function (args, kwargs)
     					{
							var msg1 = {topic: this.topic,  payload: {args: args, kwargs: kwargs}
						};
                        node.send(msg1);
                    });

					RED.log.info("WampClientSubscribe: router: " + this.router + ". procedure: " + this.procedure + ". uri: " + this.topic);	
				}

			);	
			
			
			
    		RED.log.info("WampClientSubscribe() ClientNode EXIT.");
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done)
		{
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
			RED.log.info("WampClientSubscribe() ClientNode CLOSE.");
        });
    }
    RED.nodes.registerType("wamp subs", WampClientSubscribe);
	
    //-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Request|8|  Node for requesting current GPO state	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//-------------------------------------------------------------------------------------------------------------------
function ZenitelGPORequest(config) {
    RED.nodes.createNode(this, config);
    this.router = config.router;
    this.procedure = "com.zenitel.devices.device.gpos"; 
    this.dirno = config.device_id || config.dirno; 
    this.gpo_id = config.gpo_id || config.id;
    this.clientNode = RED.nodes.getNode(this.router);

    
     if (!this.clientNode) {
      RED.log.error("wamp client config is missing!");
      return;
    }

    const node = this;
    node.wampClient = this.clientNode.wampClient();

    this.clientNode.on("ready", function () {
      node.status({ fill: "green", shape: "dot", text: "node-red:common.status.connected" });
    });
    this.clientNode.on("closed", function () {
      node.status({ fill: "red", shape: "ring", text: "node-red:common.status.not-connected" });
    });

    node.on("input", function (msg, send, done) {
      send = send || node.send;

      const payload = ensurePayloadObject(msg);

      assignConfigValue(payload, node.dirno, ["dirno", "device_id"]);
      assignConfigValue(payload, node.gpo_id, ["id", "gpo_id"]);
      syncAliases(payload, ["dirno", "device_id"]);
      syncAliases(payload, ["id", "gpo_id"]);

      let dirno = payload.dirno;
      if (dirno !== undefined && dirno !== null) {
        dirno = String(dirno).trim();
        if (dirno === "") {
          dirno = undefined;
        }
      }

      let outputId = payload.id;
      // fallback to config value
      if (outputId === undefined) {
        outputId = node.gpo_id;
      }
      let requestAll = false;
      if (outputId !== undefined && outputId !== null) {
        outputId = String(outputId).trim();
        if (outputId === "" || outputId.toLowerCase() === "all") {
          requestAll = true;
          outputId = undefined; // omit to request all
        } else if (outputId === "*") {
          requestAll = true;
          outputId = undefined;
        }
      } else {
        requestAll = true;
      }

      if (!dirno) {
        reportMissing(node, msg, send, done, ["dirno"]);
        return;
      }

      const callPayload = {
        dirno: dirno
      };

      if (outputId !== undefined && outputId !== null) {
        callPayload.id = outputId;
      }

      if (requestAll) {
        (async () => {
          try {
            const data = await restFetchGpioList("gpos", dirno, node.clientNode);
            msg.payload = data;
            send(msg);
            if (done) done();
          } catch (err) {
            const em = (err && (err.message || err.error)) ? (err.message || err.error) : String(err);
            node.error(em, msg);
            msg.error = em;
            send(msg);
            if (done) done(err);
          }
        })();
      } else {
        const callMessage = wrapWampCallPayload(callPayload); 
        const result = node.wampClient.callProcedure(node.procedure, callMessage);

        handleWampCallResult(result, node, msg, send, done);
      }
    });

    this.on("close", function (done) {
      if (this.clientNode) this.clientNode.close(done);
      else done();
    });
  }




  RED.nodes.registerType("Zenitel GPO Request", ZenitelGPORequest);

  //-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//--	|Request|9|  Node for requesting current GPI state	-->
//-------------------------------------------------------------------------------------------------------------------------------------------------------------------->
//-------------------------------------------------------------------------------------------------------------------
function ZenitelGPIRequest(config) {
    RED.nodes.createNode(this, config);
    this.router = config.router;
    this.procedure = "com.zenitel.devices.device.gpis"; 
    this.dirno = config.device_id || config.dirno; 
    this.gpi_id = config.gpi_id || config.id;
    this.clientNode = RED.nodes.getNode(this.router);

    
     if (!this.clientNode) {
      RED.log.error("wamp client config is missing!");
      return;
    }

    const node = this;
    node.wampClient = this.clientNode.wampClient();

    this.clientNode.on("ready", function () {
      node.status({ fill: "green", shape: "dot", text: "node-red:common.status.connected" });
    });
    this.clientNode.on("closed", function () {
      node.status({ fill: "red", shape: "ring", text: "node-red:common.status.not-connected" });
    });

    node.on("input", function (msg, send, done) {
      send = send || node.send;

      const payload = ensurePayloadObject(msg);

      assignConfigValue(payload, node.dirno, ["dirno", "device_id"]);
      assignConfigValue(payload, node.gpi_id, ["id", "gpi_id"]);
      syncAliases(payload, ["dirno", "device_id"]);
      syncAliases(payload, ["id", "gpi_id"]);

      let dirno = payload.dirno;
      if (dirno !== undefined && dirno !== null) {
        dirno = String(dirno).trim();
        if (dirno === "") {
          dirno = undefined;
        }
      }

      let outputId = payload.id;
      if (outputId === undefined) {
        outputId = node.gpi_id;
      }
      let requestAll = false;
      if (outputId !== undefined && outputId !== null) {
        outputId = String(outputId).trim();
        if (outputId === "" || outputId.toLowerCase() === "all") {
          requestAll = true;
          outputId = undefined;
        } else if (outputId === "*") {
          requestAll = true;
          outputId = undefined;
        }
      } else {
        requestAll = true;
      }

      if (!dirno) {
        reportMissing(node, msg, send, done, ["dirno"]);
        return;
      }

      const callPayload = {
        dirno: dirno
      };

      if (outputId !== undefined && outputId !== null) {
        callPayload.id = outputId;
      }

      if (requestAll) {
        (async () => {
          try {
            const data = await restFetchGpioList("gpis", dirno, node.clientNode);
            msg.payload = data;
            send(msg);
            if (done) done();
          } catch (err) {
            const em = (err && (err.message || err.error)) ? (err.message || err.error) : String(err);
            node.error(em, msg);
            msg.error = em;
            send(msg);
            if (done) done(err);
          }
        })();
      } else {
        const callMessage = wrapWampCallPayload(callPayload); 
        const result = node.wampClient.callProcedure(node.procedure, callMessage);

        handleWampCallResult(result, node, msg, send, done);
      }
    });

    this.on("close", function (done) {
      if (this.clientNode) this.clientNode.close(done);
      else done();
    });
  }




  RED.nodes.registerType("Zenitel GPI Request", ZenitelGPIRequest);
//-------------------------------------------------------------------------------------------------------------------	
	
    async function GetToken(id, passw, address)
	{
		RED.log.info("GetToken.");

		var _token = "";
		var encoded = btoa(id + ":" + passw);
		
//EM		RED.log.info("WampClientPool: authid: " + id + ". password: " + passw + ". url: " + address);
		
		var addr = address.replace(" ", "");
		var encrypt  = addr.includes("wss");
		const addrPortArray = addr.split(':');
		var ipAddr = "168.254.1.5";
		ipAddr = addrPortArray[1].substring(2);
		var _url = "";

//EM		RED.log.info("WampClientPool: addrPortArray: " + addrPortArray);
//EM		RED.log.info("WampClientPool: IP-addr: " + ipAddr + ". Encrypted: " + encrypt.toString());
		
		if (encrypt)
		{
			_url = "https://" + ipAddr + ":443/api/auth/login";
		}
		else
		{
			_url = "http://" + ipAddr + ":80/api/auth/login";
		}
		
		RED.log.info("WampClientPool: url: " + _url);
			
		let response;
		try {
			response = await fetch(_url,
										{
										  method: "POST",
										  headers:
										  {
											"ContentType" : "application/json",
											"Accept" : "application/json",
											"Timeout" : 5000,										
											"Authorization" : "Basic " + encoded,
										  },
										});
		} catch (e) {
			// network-level error (e.g., host down). Preserve status if present.
			e.status = e.status || undefined;
			throw e;
		}

		let json_object = await response.json();

		if (response.ok)
		{
			var json_text = JSON.stringify(json_object);	
			_token = json_object["access_token"];
			
			RED.log.info("Token Received OK.");
		}
		else
		{
				var err = new Error("GetToken fails. HTTP status " + response.status);
				err.status = response.status;
				throw err;
		}

        if (!_token) {
            throw new Error("GetToken did not return access_token");
        }

		return _token;	
	}




    var wampClientPool = (function ()
	{
        var connections = {};
        function buildKey(address, realm, authid, password) {
            return [realm || "", address || "", authid || "", password || ""].join("|");
        }
        return {
            get: function (address, realm, authid, password) {
                var uri = buildKey(address, realm, authid, password);

                if (connections[uri] && connections[uri]._authFailed) {
                    connections[uri]._closing = true;
                    connections[uri].close();
                    delete connections[uri];
                }

                if (!connections[uri])
				{
                    connections[uri] = (function ()
					{
                        var obj = {
                            _emitter: new events.EventEmitter(),
                            wampConnection: null,
                            wampSession: null,
                            _connecting: false,
                            _connected: false,
                            _closing: false,
                            _authFailed: false,
                            _reconnectTimer: null,
                            _retryAttempt: 0,
                            _connectWatchdog: null,
                            _subscribeReqMap: {}, // topic -> [handlers]
                            _subscribeFanout: {},  // topic -> fanout handler
                            _subscribeMap: {},     // topic -> subscription/promise
                            _procedureReqMap: {},
                            _procedureMap: {},
                            _address: address,
                            _realm: realm,
                            _authid: authid,
                            _password: password,
                            _poolKey: uri,
                            _getFanout: function (topic) {
                                if (!this._subscribeFanout[topic]) {
                                    var self = this;
                                    this._subscribeFanout[topic] = function (args, kwargs) {
                                        var handlers = self._subscribeReqMap[topic] || [];
                                        var ctx = this; // preserve Autobahn subscription context for handlers expecting this.topic
                                        handlers.forEach(function (handler) {
                                            try {
                                                handler.call(ctx, args, kwargs);
                                            } catch (err) {
                                                RED.log.warn("wamp subscriber handler error for topic [" + topic + "]: " + (err && err.stack ? err.stack : err));
                                            }
                                        });
                                    };
                                }
                                return this._subscribeFanout[topic];
                            },
                            on: function (a, b) {
                                this._emitter.on(a, b);
                            },
                            close: function () {
                                _disconnect();
                            },
                            publish: function (topic, message) {
                                if (this.wampSession) {
                                    RED.log.debug("wamp publish: topic=" + topic + ", message=" + JSON.stringify(message));
                                    if (message instanceof Object) {
                                        this.wampSession.publish(topic, null, message);
                                    } else if (Array.isArray(message)) {
                                        this.wampSession.publish(topic, message);
                                    } else {
                                        this.wampSession.publish(topic, [message]);
                                    }
                                } else {
                                    RED.log.warn("publish failed, wamp is not connected.");
                                }
                            },
                            subscribe: function (topic, handler) {
                                RED.log.debug("add to wamp subscribe request for topic: " + topic);
                                if (!this._subscribeReqMap[topic]) {
                                    this._subscribeReqMap[topic] = [];
                                }
                                this._subscribeReqMap[topic].push(handler);

                                if (this._connected && this.wampSession && !this._subscribeMap[topic]) {
                                    var fanout = this._getFanout(topic);
                                    this._subscribeMap[topic] = this.wampSession.subscribe(topic, fanout);
                                }
                            },
                           
                            registerProcedure: function (procedure, handler) {
                                RED.log.debug("add to wamp request for procedure: " + procedure);
                                this._procedureReqMap[procedure] = handler;

                                if (this._connected && this.wampSession) {
                                    this._procedureMap[procedure] = this.wampSession.subscribe(procedure, handler);
                                }
                            },
                            callProcedure: function (procedure, message) {
                                if (!this.wampSession) {
                                    RED.log.warn("call failed, wamp is not connected.");
                                    return;
                                }

                                RED.log.debug("wamp call: procedure=" + procedure + ", message=" + JSON.stringify(message));

                                let d;
                                if (message && typeof message === "object" && !Array.isArray(message) && (Object.prototype.hasOwnProperty.call(message, "args") || Object.prototype.hasOwnProperty.call(message, "kwargs"))) {
                                    const args = Array.isArray(message.args) ? message.args : [];
                                    const kwargs = (message.kwargs && typeof message.kwargs === "object") ? message.kwargs : {};
                                    d = this.wampSession.call(procedure, args, kwargs);
                                } else if (Array.isArray(message)) {
                                    d = this.wampSession.call(procedure, message);
                                } else if (message !== null && typeof message === "object") {
                                    d = this.wampSession.call(procedure, [], message);
                                } else if (message === undefined) {
                                    d = this.wampSession.call(procedure, []);
                                } else {
                                    d = this.wampSession.call(procedure, [message]);
                                }

                                return d;
                            }
                        };

                        var _disconnect = function() {
                            if (obj._reconnectTimer) {
                                clearTimeout(obj._reconnectTimer);
                                obj._reconnectTimer = null;
                            }
                            if (obj._connectWatchdog) {
                                clearTimeout(obj._connectWatchdog);
                                obj._connectWatchdog = null;
                            }
                            if (obj.wampConnection) {
                                obj._closing = true;
                                obj.wampConnection.close();
                            }
                        };

                        var scheduleReconnect = function (details) {
                            if (obj._closing || obj._authFailed) {
                                RED.log.debug("wamp client reconnect skipped (closing/authFailed)");
                                return;
                            }
                            var delaySeconds = 1.5;
                            if (details && typeof details.retry_delay === "number" && isFinite(details.retry_delay)) {
                                delaySeconds = details.retry_delay;
                            } else {
                                // simple backoff capped at 10 seconds
                                delaySeconds = Math.min(10, 1.5 * Math.pow(1.5, obj._retryAttempt));
                            }
                            obj._retryAttempt += 1;
                            var delayMs = delaySeconds * 1000;
                            if (obj._reconnectTimer) {
                                clearTimeout(obj._reconnectTimer);
                            }
                            RED.log.debug("wamp client reconnect scheduled in " + delayMs + " ms (attempt " + (obj._retryAttempt+1) + ")");
                            obj._reconnectTimer = setTimeout(function () {
                                obj._reconnectTimer = null;
                                obj._connecting = false; // allow new connect attempt
                                RED.log.debug("wamp client reconnect firing attempt " + obj._retryAttempt);
                                setupWampClient();
                            }, delayMs);
                        };

                        var setupWampClient = function () {
                            if (obj._reconnectTimer) {
                                clearTimeout(obj._reconnectTimer);
                                obj._reconnectTimer = null;
                            }
                            if (obj._connectWatchdog) {
                                clearTimeout(obj._connectWatchdog);
                                obj._connectWatchdog = null;
                            }
                            RED.log.debug("wamp client connecting (attempt " + (obj._retryAttempt+1) + ")");
                            obj._closing = false;
                            obj._authFailed = false;
                            obj._connecting = true;
                            obj._connected = false;
                            // keep retryAttempt to grow backoff
                            obj._emitter.emit("closed");
														
//EM							RED.log.info("WampClientPool: authid: " + authid + ". password: " + password + ". url: " + address);
							
							var encrypt  = address.includes("wss");
							
							if (encrypt)
							{
							
								var options = {
									url: address,
									realm: realm,
									retry_if_unreachable: false, // external retry loop handles reconnects
									max_retries: 0,
									authmethods: ['ticket'],
									authid: authid,
									key: "", //fs.readFileSync('ZenitelConnectPrivateKey.key', 'utf8'),
									cert: "", //fs.readFileSync('ZenitelConnectServerCertificate.crt', 'utf8'),
									ca:   "", //fs.readFileSync('ZenitelConnectServerCertificate.crt', 'utf8'),
									rejectUnauthorized: false,
									onchallenge: function ()
									{																
										return GetToken(authid, password, address).catch(function (err) {
                                            var status = err && err.status;
                                            // Only stop retrying on real auth errors (401/403). Network errors should keep retrying.
                                            obj._authFailed = (status === 401 || status === 403);
                                            obj._closing = false;
                                            obj._emitter.emit("closed");
                                            if (obj.wampConnection) {
                                                try { obj.wampConnection.close(); } catch (e) {}
                                            }
                                            throw err;
                                        });
									}
								};
							}
							else
							{
								var options = {
									url: address,
									realm: realm,
									retry_if_unreachable: false, // external retry loop handles reconnects
									max_retries: 0,
									authmethods: ['ticket'],
									authid: authid,
									onchallenge: function ()
									{																
										return GetToken(authid, password, address).catch(function (err) {
                                            var status = err && err.status;
                                            obj._authFailed = (status === 401 || status === 403);
                                            obj._closing = false;
                                            obj._emitter.emit("closed");
                                            if (obj.wampConnection) {
                                                try { obj.wampConnection.close(); } catch (e) {}
                                            }
                                            throw err;
                                        });
									}
								};

							}

                            obj.wampConnection = new autobahn.Connection(options);

                            obj.wampConnection.onopen = function (session) {

//                                RED.log.info("wamp client [" + JSON.stringify(options) + "] connected.");
                                if (obj._connectWatchdog) {
                                    clearTimeout(obj._connectWatchdog);
                                    obj._connectWatchdog = null;
                                }

                                obj.wampSession = session;
                                obj._connected = true;
                                obj._retryAttempt = 0;
                                obj._emitter.emit("ready");

                                obj._subscribeMap = {};
                                for (var topic in obj._subscribeReqMap) {
                                    (function (subTopic) {
                                        var fanout = obj._getFanout(subTopic);
                                        obj.wampSession.subscribe(subTopic, fanout).then(
                                            function (subscription) {
                                                obj._subscribeMap[subTopic] = subscription;
                                                RED.log.debug("wamp subscribe topic [" + subTopic + "] success.");
                                            },
                                            function (err) {
                                                var errDetails = "";
                                                if (err) {
                                                    if (err.error || err.message) {
                                                        errDetails = err.error || err.message;
                                                    } else {
                                                        try {
                                                            errDetails = JSON.stringify(err);
                                                        } catch (stringifyErr) {
                                                            errDetails = String(err);
                                                        }
                                                    }
                                                }
                                                RED.log.warn("wamp subscribe topic ["+subTopic+"] failed: " + errDetails);
                                            }
                                        );
                                    }(topic));
                                }

                                obj._procedureMap = {};
                                for (var procedure in obj._procedureReqMap) {
                                    obj.wampSession.register(procedure, obj._procedureReqMap[procedure]).then(
                                        function (registration) {
                                            obj._procedureMap[procedure] = registration;
                                            RED.log.debug("wamp register procedure [" + procedure + "] success.");
                                        },
                                        function (err) {
                                            var regErrDetails = "";
                                            if (err) {
                                                if (err.error || err.message) {
                                                    regErrDetails = err.error || err.message;
                                                } else {
                                                    try {
                                                        regErrDetails = JSON.stringify(err);
                                                    } catch (stringifyErr) {
                                                        regErrDetails = String(err);
                                                    }
                                                }
                                            }
                                            RED.log.warn("wamp register procedure ["+procedure+"] failed: " + regErrDetails);
                                        }
                                    )
                                }

                                obj._connecting = false;
                            };

                            obj.wampConnection.onclose = function (reason, details) {
                                if (obj._connectWatchdog) {
                                    clearTimeout(obj._connectWatchdog);
                                    obj._connectWatchdog = null;
                                }
                                obj._connecting = false;
                                obj._connected = false;
                                var stopRetry = obj._closing || obj._authFailed;
                                RED.log.debug("wamp client onclose stopRetry=" + stopRetry + " closing=" + obj._closing + " authFailed=" + obj._authFailed + " reason=" + reason + " details=" + JSON.stringify(details));
                                if (!obj._closing) {
                                    obj._emitter.emit("closed");
                                }
                                obj._subscribeMap = {};
                                RED.log.info("wamp client closed");
                                // If we're not explicitly closing or blocked by auth failure, drive our own reconnect timer.
                                if (!stopRetry) {
                                    scheduleReconnect(details);
                                }
                                // prevent Autobahn internal loop from logging "disabled" by explicitly disabling it
                                if (obj.wampConnection && obj.wampConnection._retry !== undefined) {
                                    obj.wampConnection._retry = false;
                                }
                                return false;
                            };

                            obj.wampConnection.open();

                            // Watchdog: if neither open nor close fires within 10 seconds, force retry
                            obj._connectWatchdog = setTimeout(function () {
                                if (obj._connected) { return; }
                                RED.log.debug("wamp client connect watchdog fired; forcing reconnect");
                                try {
                                    if (obj.wampConnection) { obj.wampConnection.close(); }
                                } catch (e) {}
                                obj._connecting = false;
                                scheduleReconnect({});
                            }, 10000);
                        };

                        setupWampClient();
                        return obj;
                    }());
                }
                return connections[uri];
            },
            close: function (address, realm, authid, password, done) {
                var uri = buildKey(address, realm, authid, password);
                if (connections[uri]) {
                    RED.log.info("ready to close wamp client [" + uri +"]");
                    connections[uri]._closing = true;
                    connections[uri].close();
                    (typeof(done) == 'function') && done();
                    delete connections[uri];
                } else {
                    (typeof(done) == 'function') && done();
                }
            }
        }
    }());
}
