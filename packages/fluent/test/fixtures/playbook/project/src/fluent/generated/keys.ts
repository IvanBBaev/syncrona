import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    act_first: {
                        table: 'sys_pd_activity'
                        id: '2179b008a1864cf6946896d0c434a188'
                    }
                    act_note: {
                        table: 'sys_pd_activity'
                        id: '50d1068e1cf443e7803e8ff367733d6f'
                    }
                    act_second: {
                        table: 'sys_pd_activity'
                        id: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                    }
                    bom_json: {
                        table: 'sys_module'
                        id: 'd917c9574cf4446d88b19d41fa039edf'
                    }
                    lane_follow: {
                        table: 'sys_pd_lane'
                        id: '27e7f3d5e8c34f2cba118f9a75d4d6b4'
                    }
                    lane_main: {
                        table: 'sys_pd_lane'
                        id: '53273984f4be4e28a61a0d069f8a2dad'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: 'eab7a5e63b1c474c9c929009f294d8a5'
                    }
                    pb: {
                        table: 'sys_pd_process_definition'
                        id: 'd7211147a4b445e1be7087c05c3966b3'
                    }
                    pb_trig: {
                        table: 'sys_pd_trigger_instance'
                        id: 'd62752047bda40f9983b41ad265614e4'
                    }
                    src_server_script_ts: {
                        table: 'sys_module'
                        id: '78ceb46029434f96b1ac2eca3f806372'
                    }
                }
                composite: [
                    {
                        table: 'sys_variable_value'
                        id: '038b37018f434d19bd7ff86ff2b49294'
                        key: {
                            document_key: '2179b008a1864cf6946896d0c434a188'
                            variable: '9c6b7e22c3211010381b60bc0eba8f98'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: '04bc3b262382485fac0c44ac23072909'
                        key: {
                            document_key: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            variable: '267e68875b00001070e4492c11f91a34'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '0a2b772bb61346fd9a21472b6a593655'
                        key: {
                            id: '2179b008a1864cf6946896d0c434a188'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'experience_status_table'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '0baac2cc15b949e88a16fa52636e939d'
                        key: {
                            id: '50d1068e1cf443e7803e8ff367733d6f'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'is_automated'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '112b4804cc0b4ccd877b1fe791fe6c10'
                        key: {
                            id: '2179b008a1864cf6946896d0c434a188'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'associated_record'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: '1706229d28ee4f55ba3441cd5732c9da'
                        key: {
                            document_key: 'd62752047bda40f9983b41ad265614e4'
                            variable: 'fb1af07d0f0010108c87f4f0ff767e00'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '1b97f2f0889e47c7b15fd225ed93397b'
                        key: {
                            id: '2179b008a1864cf6946896d0c434a188'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'description'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '1d279eb614814d34b06061f97b607231'
                        key: {
                            id: '50d1068e1cf443e7803e8ff367733d6f'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'icon'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: '2148743f00124ee6917ab8f04d40de06'
                        key: {
                            document_key: '2179b008a1864cf6946896d0c434a188'
                            variable: '661d304673030010fe4a6da44cf6a7b1'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '2ba72dc97b6841a5815ff814f2f0aacc'
                        key: {
                            id: '2179b008a1864cf6946896d0c434a188'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'tagline'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '2d43d9b659bf4c74be11e614dba8629b'
                        key: {
                            id: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'tagline'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '30f579fa9e0f47e3b448af1da1f1d92b'
                        key: {
                            id: 'd62752047bda40f9983b41ad265614e4'
                            table: 'var__m_sys_pd_process_input_d7211147a4b445e1be7087c05c3966b3'
                            field: 'parent_record'
                        }
                    },
                    {
                        table: 'sys_pd_process_input'
                        id: '35a59ac2425a4efcbb38537c2a18d558'
                        key: {
                            element: 'parent_record'
                            model: 'd7211147a4b445e1be7087c05c3966b3'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: '36f5ba31141045c69ac93d98fccacff4'
                        key: {
                            document_key: '50d1068e1cf443e7803e8ff367733d6f'
                            variable: '55628762c3211010381b60bc0eba8fec'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '381484acb631421dbda17cfd005d5bf9'
                        key: {
                            id: '2179b008a1864cf6946896d0c434a188'
                            table: 'var__m_sys_hub_flow_input_2b8b42e31b630010affd0e55cc4bcbe9'
                            field: 'message'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '3e2c633144194a528f571e5ee0bc7137'
                        key: {
                            id: '2179b008a1864cf6946896d0c434a188'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'icon'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: '423e5697052144c6b28a36e2c1f041af'
                        key: {
                            document_key: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            variable: 'ffcd02671b630010affd0e55cc4bcbdf'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: '4916aaec15b1417a94b7bc28278e93c9'
                        deleted: true
                        key: {
                            document_key: 'd62752047bda40f9983b41ad265614e4'
                            variable: '2a8a7851ff2200108c8733af793bf131'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '493ab9d21df44f98aa40adbf9f34d720'
                        key: {
                            id: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            table: 'var__m_sys_hub_flow_input_a7cd02671b630010affd0e55cc4bcbd1'
                            field: 'completed_message'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: '493c8ae5027946a7ae85036e7520587a'
                        key: {
                            document_key: '2179b008a1864cf6946896d0c434a188'
                            variable: 'c23322e91bbb001094630f28cc4bcbae'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '4ed5cca5143149cf9e154b29a8d3b381'
                        key: {
                            id: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            table: 'var__m_sys_hub_flow_input_a7cd02671b630010affd0e55cc4bcbd1'
                            field: 'assigned_to'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '5308346b3a344bd7b88117bea7a045b8'
                        key: {
                            id: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'associated_record'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: '58d087f7ee6b42aa9a1b7d4efa0dd866'
                        key: {
                            document_key: '2179b008a1864cf6946896d0c434a188'
                            variable: '6c9c4ee31b630010affd0e55cc4bcbbf'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: '592c04ad05ee44ebb157bff628783603'
                        key: {
                            document_key: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            variable: '661d304673030010fe4a6da44cf6a7b1'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '5c561097b1cd4087a934572de3d95f62'
                        key: {
                            id: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'associated_table'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '5d2b032c2d22445c939e929860cf8416'
                        key: {
                            id: '50d1068e1cf443e7803e8ff367733d6f'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'experience_status_table'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '5de2df0295834a7290c49df11a67270c'
                        key: {
                            id: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'icon'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '602129ffc38b45d7844a29f13c242415'
                        key: {
                            id: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'title'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: '64c72ee70e584db5b32586d63cbc1183'
                        key: {
                            document_key: '50d1068e1cf443e7803e8ff367733d6f'
                            variable: 'ec5d96eac7e60010bfbaf89f51c2605d'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '64eedc634fb246d5880622473208f30d'
                        key: {
                            id: '2179b008a1864cf6946896d0c434a188'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'title'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '6670519397cb416da2adf4b5f6299afb'
                        key: {
                            id: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'experience_status_record'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: '6c7624a2e4fa4fecafa9feb37c885777'
                        key: {
                            document_key: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            variable: '9c6b7e22c3211010381b60bc0eba8f98'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '6cdf9377f57f48948f8a6b6da51bb9fc'
                        key: {
                            id: '50d1068e1cf443e7803e8ff367733d6f'
                            table: 'var__m_sys_hub_flow_input_2b8b42e31b630010affd0e55cc4bcbe9'
                            field: 'message'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: '717a769559b04494b908532aa9f3fd73'
                        key: {
                            document_key: '2179b008a1864cf6946896d0c434a188'
                            variable: 'ec5d96eac7e60010bfbaf89f51c2605d'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: '7284d51756294b61a02be5674a53049b'
                        key: {
                            document_key: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            variable: 'ec5d96eac7e60010bfbaf89f51c2605d'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '741ddd682f4143cc873a8c831f4db001'
                        key: {
                            id: '50d1068e1cf443e7803e8ff367733d6f'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'associated_record'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '7a3920845edd46b69ea66bc6a27ccaf5'
                        key: {
                            id: '50d1068e1cf443e7803e8ff367733d6f'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'description'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: '82eae5fff6944bd494b4362531d26dc2'
                        key: {
                            document_key: '2179b008a1864cf6946896d0c434a188'
                            variable: '24bdf44673030010fe4a6da44cf6a707'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: '83c9c537e6934e8cab50889494136b96'
                        key: {
                            document_key: '2179b008a1864cf6946896d0c434a188'
                            variable: '267e68875b00001070e4492c11f91a34'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '85e456c7f2c74d01a952ec4e161e13b7'
                        key: {
                            id: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            table: 'var__m_sys_hub_flow_input_a7cd02671b630010affd0e55cc4bcbd1'
                            field: 'assignment_group'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '868121e4868d400abe7e08a7d6997ff1'
                        key: {
                            id: '50d1068e1cf443e7803e8ff367733d6f'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'experience_status_record'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '8c3d883dda494bcd8f36d952993562b3'
                        key: {
                            id: '2179b008a1864cf6946896d0c434a188'
                            table: 'var__m_sys_hub_flow_input_2b8b42e31b630010affd0e55cc4bcbe9'
                            field: 'wait'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: '8d829eb790b14a5891f8b62202281daf'
                        key: {
                            document_key: '50d1068e1cf443e7803e8ff367733d6f'
                            variable: '49ed24875b00001070e4492c11f91aa5'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: '907cf4e0ab264ea1a242cdec86d0ed4a'
                        key: {
                            document_key: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            variable: 'a73fce671b630010affd0e55cc4bcbbb'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: '90883a1e074c4eb4a246e77303b456a8'
                        key: {
                            document_key: 'd62752047bda40f9983b41ad265614e4'
                            variable: '52ce78d1ff2200108c8733af793bf1b3'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '922044f3f0c64b31aa2dd727037ab42b'
                        key: {
                            id: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'is_automated'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '9c272ad61b7b4b5c9328db2ba3c972ec'
                        key: {
                            id: '2179b008a1864cf6946896d0c434a188'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'experience_status_record'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: '9c7d87bf34ea4b509f5e54fe1af5c1b2'
                        key: {
                            document_key: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            variable: '49ed24875b00001070e4492c11f91aa5'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: '9d8efe30d29a43b7aa5625f7d9774549'
                        key: {
                            id: '50d1068e1cf443e7803e8ff367733d6f'
                            table: 'var__m_sys_hub_flow_input_2b8b42e31b630010affd0e55cc4bcbe9'
                            field: 'wait'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: '9eb2958ec8e145ec90fdbae6e0b30cb7'
                        key: {
                            document_key: '50d1068e1cf443e7803e8ff367733d6f'
                            variable: '6c9c4ee31b630010affd0e55cc4bcbbf'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: 'a2eb79b4e3df4992b6d3a11c2ee7a460'
                        key: {
                            document_key: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            variable: 'f8b3aae91bbb001094630f28cc4bcb2b'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: 'a70fb051d32c49df97e4236bed0d14e7'
                        deleted: true
                        key: {
                            document_key: 'd62752047bda40f9983b41ad265614e4'
                            variable: 'a8ae38d1ff2200108c8733af793bf15c'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: 'a9805552e4524afeb973cc7376b13979'
                        key: {
                            id: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            table: 'var__m_sys_hub_flow_input_a7cd02671b630010affd0e55cc4bcbd1'
                            field: 'initial_message'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: 'acb3271598d54077b3346d811a0c9ff8'
                        key: {
                            document_key: '50d1068e1cf443e7803e8ff367733d6f'
                            variable: '78f334b8c763001085f5532bb4c26009'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: 'b962389c9c554be481844ca53b6b0ee1'
                        key: {
                            document_key: '50d1068e1cf443e7803e8ff367733d6f'
                            variable: 'c23322e91bbb001094630f28cc4bcbae'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: 'beaebf45ba214d6eada39063bf5afe86'
                        key: {
                            document_key: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            variable: '24bdf44673030010fe4a6da44cf6a707'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: 'bfa9ec84a8c44a379ed50837557e7bff'
                        key: {
                            document_key: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            variable: '78f334b8c763001085f5532bb4c26009'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: 'c2796eefb838407fbb1aada70f348c77'
                        key: {
                            document_key: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            variable: '233fce671b630010affd0e55cc4bcbcd'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: 'c3681ac0264642f0aa4f6d4bc45c36df'
                        key: {
                            document_key: '50d1068e1cf443e7803e8ff367733d6f'
                            variable: '9c6b7e22c3211010381b60bc0eba8f98'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: 'c3713171e8124f3fa61ab434dcf54608'
                        key: {
                            document_key: '50d1068e1cf443e7803e8ff367733d6f'
                            variable: 'eb0474b8c763001085f5532bb4c260f5'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: 'c58558261aeb4cb7b94ab28cb395fb34'
                        key: {
                            document_key: '50d1068e1cf443e7803e8ff367733d6f'
                            variable: '661d304673030010fe4a6da44cf6a7b1'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: 'c62841b1d57a44faa712aaf690a6174f'
                        key: {
                            id: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'experience_status_table'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: 'c8e6bc50da284cbf9161be4aed186a87'
                        key: {
                            document_key: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            variable: 'eb0474b8c763001085f5532bb4c260f5'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: 'd19bf69d3ab141e6adb135ea502802e4'
                        key: {
                            document_key: 'd62752047bda40f9983b41ad265614e4'
                            variable: '82be38d1ff2200108c8733af793bf1a7'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: 'd4b31faf82ef4543b9db99e507197d53'
                        key: {
                            id: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'description'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: 'e49d5d0e8d5c4db58b92f73e60aaad7e'
                        key: {
                            document_key: '50d1068e1cf443e7803e8ff367733d6f'
                            variable: '267e68875b00001070e4492c11f91a34'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: 'e59f8db3f9f24646a742ee342c0d6425'
                        key: {
                            document_key: 'd62752047bda40f9983b41ad265614e4'
                            variable: '35a59ac2425a4efcbb38537c2a18d558'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: 'e869912af7ac444e952d12ab4a554f09'
                        key: {
                            id: '2179b008a1864cf6946896d0c434a188'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'is_automated'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: 'ea21151140ea4236a890c236452fe2ce'
                        key: {
                            document_key: '2179b008a1864cf6946896d0c434a188'
                            variable: '49ed24875b00001070e4492c11f91aa5'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: 'ebe82a8050ad48fd9f19fe335031f60b'
                        key: {
                            id: '50d1068e1cf443e7803e8ff367733d6f'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'title'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: 'ec9a62dbf4c245afb061940b89df13dc'
                        key: {
                            document_key: '6dcc3a29d41d4095b5ab4c9b3c5828c8'
                            variable: '55628762c3211010381b60bc0eba8fec'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: 'ed6eb7a387a646a690f109d901a9ff5b'
                        key: {
                            document_key: '2179b008a1864cf6946896d0c434a188'
                            variable: 'eb0474b8c763001085f5532bb4c260f5'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: 'f333dc9b8af4417db1666cce4019f9ff'
                        key: {
                            document_key: '2179b008a1864cf6946896d0c434a188'
                            variable: '55628762c3211010381b60bc0eba8fec'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: 'f3b8bd53121d417d8ac1f9a4eef9371b'
                        key: {
                            document_key: '2179b008a1864cf6946896d0c434a188'
                            variable: '78f334b8c763001085f5532bb4c26009'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: 'f71bf55572e34971903a1413258f8978'
                        key: {
                            id: '2179b008a1864cf6946896d0c434a188'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'associated_table'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: 'f7381b503693442d9c985ad41140e07b'
                        key: {
                            id: '50d1068e1cf443e7803e8ff367733d6f'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'associated_table'
                        }
                    },
                    {
                        table: 'sys_variable_value'
                        id: 'f81c87d1c57e413eb36a3b7ac47d6cf3'
                        key: {
                            document_key: '50d1068e1cf443e7803e8ff367733d6f'
                            variable: '24bdf44673030010fe4a6da44cf6a707'
                        }
                    },
                    {
                        table: 'sys_element_mapping'
                        id: 'ff899364047641f7a713743ed5e712b9'
                        key: {
                            id: '50d1068e1cf443e7803e8ff367733d6f'
                            table: 'var__m_sys_pd_activity_type_prop_d4dde0875b00001070e4492c11f91a90'
                            field: 'tagline'
                        }
                    },
                ]
            }
        }
    }
}
